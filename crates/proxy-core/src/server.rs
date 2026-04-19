use super::*;

#[allow(clippy::too_many_arguments)]
pub async fn start_proxy_server(
    config: ProxyRuntimeConfig,
    tls_manager: Option<Arc<TlsManager>>,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    rewrite_manager: Option<Arc<RewriteManager>>,
    map_manager: Option<Arc<MapManager>>,
    throttle_manager: Option<Arc<ThrottleManager>>,
    workspace_id: Option<String>,
    event_emitter: Option<BreakpointEventEmitter>,
) -> Result<StartedProxyServer, String> {
    config.validate().map_err(str::to_string)?;

    let bind_addr: &str = DEFAULT_BIND_ADDRESS;
    let listener = TcpListener::bind((bind_addr, config.port))
        .await
        .map_err(|error| format!("failed to bind proxy listener on {bind_addr}:{}: {error}", config.port))?;
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
    let (session_sender, session_receiver) = mpsc::unbounded_channel();
    let (ws_message_sender, ws_message_receiver) = mpsc::unbounded_channel();
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
                            let throttle_manager = throttle_manager.clone();
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
                                    throttle_manager,
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
                            break;
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

#[allow(clippy::too_many_arguments)]
async fn handle_connection(
    mut stream: TcpStream,
    client_addr: SocketAddr,
    client: Arc<Client>,
    session_sender: mpsc::UnboundedSender<ProxySessionDetail>,
    ws_message_sender: mpsc::UnboundedSender<crate::ws::WsMessageData>,
    tls_manager: Option<Arc<TlsManager>>,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    rewrite_manager: Option<Arc<RewriteManager>>,
    map_manager: Option<Arc<MapManager>>,
    throttle_manager: Option<Arc<ThrottleManager>>,
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
                &[
                    ("client_addr", client_addr.to_string()),
                    ("error", error),
                ],
            );

            return Ok(());
        }
    };

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
            stream.write_all(response.as_bytes()).await.map_err(|e| format!("cert write: {e}"))?;
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
                ("ssl_interception_enabled", tls_manager.is_some().to_string()),
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
                return tunnel_blind_relay(stream, &host, port).await;
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
                    session_sender,
                    ws_message_sender,
                    started_at,
                    started_at_instant,
                    breakpoint_manager,
                    rewrite_manager,
                    map_manager,
                    throttle_manager,
                    active_workspace_id,
                    event_emitter,
                )
                .await;
            }
        }
    }

    let request_runtime = apply_request_runtime_rules(
        &rewrite_manager,
        &map_manager,
        &throttle_manager,
        &active_workspace_id,
        &mut request,
    )?;

    // --- Request-stage breakpoint ---
    if let Some(resolution) = intercept_request_stage(&breakpoint_manager, &event_emitter, &mut request).await? {
        match resolution.action {
            BreakpointActionKind::Drop => {
                let _ = stream.shutdown().await;
                return Ok(());
            }
            BreakpointActionKind::Mock => {
                if let Some(ref mock) = resolution.mock {
                    if let Some(profile) = request_runtime.throttle_profile.as_ref() {
                        if let Err(error) = apply_request_throttle(profile, request.body.len()).await {
                            return respond_with_throttle_failure(
                                &mut stream,
                                &request,
                                &session_sender,
                                started_at,
                                started_at_instant,
                                None,
                                &error,
                            )
                            .await;
                        }
                    }

                    let mut mock_response = build_mock_upstream_response(mock);
                    apply_response_rewrite_rules(
                        &rewrite_manager,
                        &active_workspace_id,
                        &request,
                        &mut mock_response,
                    )?;

                    if let Some(profile) = request_runtime.throttle_profile.as_ref() {
                        apply_response_throttle(profile, mock_response.response_body.len()).await;
                    }

                    write_upstream_response(
                        &mut stream,
                        mock_response.status_code,
                        &mock_response.response_headers,
                        &mock_response.response_body,
                    )
                    .await?;

                    let detail = build_session_detail(
                        &request,
                        mock_response.status_code.as_u16(),
                        &mock_response.response_headers,
                        &mock_response.response_body,
                        started_at,
                        started_at_instant,
                        ProxyTimingBreakdown {
                            connect_ms: None,
                            dns_ms: None,
                            request_send_ms: Some(0),
                            response_read_ms: Some(0),
                            tls_ms: None,
                            total_ms: Some(started_at_instant.elapsed().as_millis()),
                            waiting_ms: Some(0),
                        },
                    );
                    if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }
                    return Ok(());
                }
            }
            BreakpointActionKind::Forward => {
                // Modifications already applied inside intercept_request_stage
            }
        }
    }

    let pending_detail = build_pending_session_detail(&request, started_at);
    if session_sender.send(pending_detail).is_err() {
        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
    }

    let RequestRuntimeOutcome {
        local_response,
        throttle_profile,
    } = request_runtime;

    if let Some(profile) = throttle_profile.as_ref() {
        if let Err(error) = apply_request_throttle(profile, request.body.len()).await {
            return respond_with_throttle_failure(
                &mut stream,
                &request,
                &session_sender,
                started_at,
                started_at_instant,
                None,
                &error,
            )
            .await;
        }
    }

    let upstream_result = match local_response {
        Some(local_response) => Ok(local_response),
        None => {
            // WebSocket upgrade requests must bypass reqwest (which can't handle 101 protocol switch).
            let is_ws = request.headers.iter().any(|(name, value)| {
                name.as_str().eq_ignore_ascii_case("upgrade") && value.as_bytes().eq_ignore_ascii_case(b"websocket")
            });
            if is_ws {
                emit_log("INFO", "ws_http_upgrade_detected", &[
                    ("request_id", request.request_id.clone()),
                    ("host", request.host.clone()),
                    ("url", request.url.to_string()),
                    ("method", request.method.to_string()),
                ]);
                handle_http_websocket_upgrade(&mut stream, &request, &session_sender, &ws_message_sender, started_at, started_at_instant).await?;
                return Ok(());
            }
            forward_request(&client, &request).await
        }
    };

    match upstream_result {
        Ok(mut upstream_response) => {
            apply_response_rewrite_rules(
                &rewrite_manager,
                &active_workspace_id,
                &request,
                &mut upstream_response,
            )?;

            // --- Response-stage breakpoint ---
            let breakpoint_resolution = match intercept_response_stage(
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
                    let detail = build_session_detail(
                        &request,
                        upstream_response.status_code.as_u16(),
                        &upstream_response.response_headers,
                        &upstream_response.response_body,
                        started_at,
                        started_at_instant,
                        ProxyTimingBreakdown {
                            connect_ms: None,
                            dns_ms: None,
                            request_send_ms: Some(0),
                            response_read_ms: Some(upstream_response.response_read_ms),
                            tls_ms: None,
                            total_ms: Some(started_at_instant.elapsed().as_millis()),
                            waiting_ms: Some(upstream_response.waiting_ms),
                        },
                    );
                    if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }
                    return Err(error);
                }
            };

            if let Some(resolution) = breakpoint_resolution {
                match resolution.action {
                    BreakpointActionKind::Drop => {
                        let detail = build_session_detail(
                            &request,
                            upstream_response.status_code.as_u16(),
                            &upstream_response.response_headers,
                            &upstream_response.response_body,
                            started_at,
                            started_at_instant,
                            ProxyTimingBreakdown {
                                connect_ms: None,
                                dns_ms: None,
                                request_send_ms: Some(0),
                                response_read_ms: Some(upstream_response.response_read_ms),
                                tls_ms: None,
                                total_ms: Some(started_at_instant.elapsed().as_millis()),
                                waiting_ms: Some(upstream_response.waiting_ms),
                            },
                        );
                        if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }
                        let _ = stream.shutdown().await;
                        return Ok(());
                    }
                    BreakpointActionKind::Mock => {
                        if let Some(ref mock) = resolution.mock {
                            upstream_response = build_mock_upstream_response(mock);
                        }
                    }
                    BreakpointActionKind::Forward => {
                        apply_response_resolution(&resolution, &mut upstream_response);
                    }
                }
            }

            if let Some(profile) = throttle_profile.as_ref() {
                apply_response_throttle(profile, upstream_response.response_body.len()).await;
            }

            if let Err(error) = write_upstream_response(
                &mut stream,
                upstream_response.status_code,
                &upstream_response.response_headers,
                &upstream_response.response_body,
            )
            .await
            {
                let detail = build_session_detail(
                    &request,
                    upstream_response.status_code.as_u16(),
                    &upstream_response.response_headers,
                    &upstream_response.response_body,
                    started_at,
                    started_at_instant,
                    ProxyTimingBreakdown {
                        connect_ms: None,
                        dns_ms: None,
                        request_send_ms: Some(0),
                        response_read_ms: Some(upstream_response.response_read_ms),
                        tls_ms: None,
                        total_ms: Some(started_at_instant.elapsed().as_millis()),
                        waiting_ms: Some(upstream_response.waiting_ms),
                    },
                );
                if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }
                return Err(error);
            }

            let detail = build_session_detail(
                &request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(upstream_response.response_read_ms),
                    tls_ms: None,
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(upstream_response.waiting_ms),
                },
            );

            if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }

            emit_log(
                "DEBUG",
                "request_forwarded",
                &[
                    ("request_id", request.request_id.clone()),
                    ("client_addr", client_addr.to_string()),
                    ("method", request.method.to_string()),
                    ("status_code", upstream_response.status_code.as_u16().to_string()),
                    ("url", request.url.to_string()),
                ],
            );

            Ok(())
        }
        Err(error) => {
            let response_message = "The proxy could not reach the upstream server.";

            write_plain_text_response(
                &mut stream,
                StatusCode::BAD_GATEWAY,
                response_message,
            )
            .await?;

            let detail = build_session_detail(
                &request,
                StatusCode::BAD_GATEWAY.as_u16(),
                &HeaderMap::new(),
                response_message.as_bytes(),
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(0),
                    tls_ms: None,
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(started_at_instant.elapsed().as_millis()),
                },
            );
            if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
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

    let mut request_builder = client.request(request.method.clone(), request.url.clone());
    request_builder = request_builder.headers(request.headers.clone());

    if !request.body.is_empty() {
        request_builder = request_builder.body(request.body.clone());
    }

    let waiting_started_at = Instant::now();
    let response = request_builder
        .send()
        .await
        .map_err(|error| {
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
    let response_body = response
        .bytes()
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
                    ("error", error.to_string()),
                ],
            );
            format!("failed to read upstream response body: {error}")
        })?
        .to_vec();
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
        response_body,
        response_headers,
        response_read_ms,
        status_code,
        waiting_ms,
    })
}

/// Blind TCP relay for CONNECT when SSL interception is disabled.
async fn tunnel_blind_relay(
    mut client_stream: TcpStream,
    host: &str,
    port: u16,
) -> Result<(), String> {
    // Send 200 Connection Established
    client_stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(map_io_error)?;

    let mut upstream = TcpStream::connect((host, port))
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
    use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use tokio_rustls::rustls::crypto::CryptoProvider;
    use tokio_rustls::rustls::DigitallySignedStruct;
    use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};

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

    let config = tokio_rustls::rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoVerifier))
        .with_no_client_auth();

    Arc::new(config)
}

/// Handle WebSocket upgrade for plain HTTP (ws://) connections.
/// Opens a raw TCP connection to upstream, sends the upgrade request, reads the 101 response,
/// writes it back to the client, then enters bidirectional frame relay.
async fn handle_http_websocket_upgrade<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    client_stream: &mut S,
    request: &ParsedProxyRequest,
    session_sender: &mpsc::UnboundedSender<ProxySessionDetail>,
    ws_message_sender: &mpsc::UnboundedSender<crate::ws::WsMessageData>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> Result<(), String> {
    let port = request.url.port().unwrap_or(80);
    let host_port = format!("{}:{}", request.host, port);

    emit_log("DEBUG", "ws_http_connecting_upstream", &[
        ("request_id", request.request_id.clone()),
        ("host_port", host_port.clone()),
    ]);

    let mut upstream = TcpStream::connect(&*host_port)
        .await
        .map_err(|e| {
            emit_log("ERROR", "ws_http_upstream_connect_failed", &[
                ("request_id", request.request_id.clone()),
                ("host_port", host_port.clone()),
                ("error", e.to_string()),
            ]);
            format!("ws upstream connect: {e}")
        })?;

    emit_log("DEBUG", "ws_http_upstream_connected", &[
        ("request_id", request.request_id.clone()),
    ]);

    let raw_req = build_raw_upgrade_request(request)?;
    emit_log("DEBUG", "ws_http_sending_upgrade", &[
        ("request_id", request.request_id.clone()),
        ("raw_req_len", raw_req.len().to_string()),
    ]);
    emit_log("DEBUG", "ws_http_raw_request", &[
        ("request_id", request.request_id.clone()),
        ("raw_req", raw_req.clone()),
    ]);

    upstream.write_all(raw_req.as_bytes()).await.map_err(|e| {
        emit_log("ERROR", "ws_http_upgrade_send_failed", &[
            ("request_id", request.request_id.clone()),
            ("error", e.to_string()),
        ]);
        format!("ws upgrade send: {e}")
    })?;

    // Read the upstream 101 response and relay it to the client
    let response_head = read_http_response_head(&mut upstream).await.map_err(|e| {
        emit_log("ERROR", "ws_http_read_response_head_failed", &[
            ("request_id", request.request_id.clone()),
            ("error", e.clone()),
        ]);
        e
    })?;

    emit_log("DEBUG", "ws_http_got_response_head", &[
        ("request_id", request.request_id.clone()),
        ("response_head", response_head.clone()),
    ]);

    // Parse status code from the response
    let status_line = response_head.lines().next().unwrap_or("");
    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(502);

    emit_log("INFO", "ws_http_upstream_status", &[
        ("request_id", request.request_id.clone()),
        ("status_code", status_code.to_string()),
    ]);

    // Write the response head back to the client
    client_stream
        .write_all(response_head.as_bytes())
        .await
        .map_err(|e| {
            emit_log("ERROR", "ws_http_write_to_client_failed", &[
                ("request_id", request.request_id.clone()),
                ("error", e.to_string()),
            ]);
            format!("ws response write to client: {e}")
        })?;
    client_stream.flush().await.map_err(|e| format!("ws flush: {e}"))?;

    emit_log("INFO", "ws_http_entering_relay", &[
        ("request_id", request.request_id.clone()),
        ("session_id", request.request_id.clone()),
    ]);

    let mut detail = build_session_detail(
        request,
        status_code,
        &HeaderMap::new(),
        &[],
        started_at,
        started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: Some(0),
            response_read_ms: Some(0),
            tls_ms: None,
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(0),
        },
    );
    detail.summary.protocol = "ws".to_string();
    detail.summary.response_mime_type = Some("websocket".to_string());
    let session_id_for_relay = detail.id.clone();
    if session_sender.send(detail).is_err() {
        return Ok(());
    }

    crate::ws::relay_websocket_frames(client_stream, &mut upstream, &session_id_for_relay, ws_message_sender).await;
    Ok(())
}

/// Handle WebSocket upgrade for HTTPS (wss://) connections via MITM.
/// Opens a raw TLS connection to upstream, sends the upgrade request, reads the 101 response,
/// writes it back to the client, then enters bidirectional frame relay.
async fn handle_https_websocket_upgrade<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    client_stream: &mut S,
    request: &ParsedProxyRequest,
    session_sender: &mpsc::UnboundedSender<ProxySessionDetail>,
    ws_message_sender: &mpsc::UnboundedSender<crate::ws::WsMessageData>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    tls_ms: u128,
) -> Result<(), String> {
    let port = request.url.port().unwrap_or(443);
    let host_port = format!("{}:{}", request.host, port);

    emit_log("DEBUG", "wss_connecting_upstream", &[
        ("request_id", request.request_id.clone()),
        ("host_port", host_port.clone()),
    ]);

    let ws_tcp = TcpStream::connect(&*host_port)
        .await
        .map_err(|e| {
            emit_log("ERROR", "wss_upstream_connect_failed", &[
                ("request_id", request.request_id.clone()),
                ("host_port", host_port.clone()),
                ("error", e.to_string()),
            ]);
            format!("wss upstream connect: {e}")
        })?;

    emit_log("DEBUG", "wss_tcp_connected", &[
        ("request_id", request.request_id.clone()),
    ]);

    let client_config = build_dangerous_client_tls_config();
    let tls_connector = tokio_rustls::TlsConnector::from(client_config);
    let ws_host = request.host.clone();
    let dns_name = tokio_rustls::rustls::pki_types::ServerName::try_from(ws_host.clone())
        .unwrap_or_else(|_| tokio_rustls::rustls::pki_types::ServerName::IpAddress(
            std::net::Ipv4Addr::LOCALHOST.into(),
        ));

    emit_log("DEBUG", "wss_starting_tls_handshake", &[
        ("request_id", request.request_id.clone()),
        ("ws_host", ws_host.clone()),
    ]);

    let mut upstream = tls_connector
        .connect(dns_name, ws_tcp)
        .await
        .map_err(|e| {
            emit_log("ERROR", "wss_tls_handshake_failed", &[
                ("request_id", request.request_id.clone()),
                ("ws_host", ws_host.clone()),
                ("error", e.to_string()),
            ]);
            format!("wss upstream tls handshake: {e}")
        })?;

    emit_log("DEBUG", "wss_tls_connected", &[
        ("request_id", request.request_id.clone()),
    ]);

    let raw_req = build_raw_upgrade_request(request)?;
    emit_log("DEBUG", "wss_sending_upgrade", &[
        ("request_id", request.request_id.clone()),
        ("raw_req_len", raw_req.len().to_string()),
    ]);
    emit_log("DEBUG", "wss_raw_request", &[
        ("request_id", request.request_id.clone()),
        ("raw_req", raw_req.clone()),
    ]);

    upstream.write_all(raw_req.as_bytes()).await.map_err(|e| {
        emit_log("ERROR", "wss_upgrade_send_failed", &[
            ("request_id", request.request_id.clone()),
            ("error", e.to_string()),
        ]);
        format!("wss upgrade send: {e}")
    })?;

    // Read the upstream 101 response and relay it to the client
    let response_head = read_http_response_head(&mut upstream).await.map_err(|e| {
        emit_log("ERROR", "wss_read_response_head_failed", &[
            ("request_id", request.request_id.clone()),
            ("error", e.clone()),
        ]);
        e
    })?;

    emit_log("DEBUG", "wss_got_response_head", &[
        ("request_id", request.request_id.clone()),
        ("response_head", response_head.clone()),
    ]);

    let status_line = response_head.lines().next().unwrap_or("");
    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(502);

    emit_log("INFO", "wss_upstream_status", &[
        ("request_id", request.request_id.clone()),
        ("status_code", status_code.to_string()),
    ]);

    client_stream
        .write_all(response_head.as_bytes())
        .await
        .map_err(|e| {
            emit_log("ERROR", "wss_write_to_client_failed", &[
                ("request_id", request.request_id.clone()),
                ("error", e.to_string()),
            ]);
            format!("wss response write to client: {e}")
        })?;
    client_stream.flush().await.map_err(|e| format!("wss flush: {e}"))?;

    emit_log("INFO", "wss_entering_relay", &[
        ("request_id", request.request_id.clone()),
        ("session_id", request.request_id.clone()),
    ]);

    let mut detail = build_session_detail(
        request,
        status_code,
        &HeaderMap::new(),
        &[],
        started_at,
        started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: Some(0),
            response_read_ms: Some(0),
            tls_ms: Some(tls_ms),
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(0),
        },
    );
    detail.summary.protocol = "wss".to_string();
    detail.summary.response_mime_type = Some("websocket".to_string());
    let session_id_for_relay = detail.id.clone();
    if session_sender.send(detail).is_err() {
        return Ok(());
    }

    crate::ws::relay_websocket_frames(client_stream, &mut upstream, &session_id_for_relay, ws_message_sender).await;
    Ok(())
}

/// Read a complete HTTP response head (status line + headers) from a stream.
/// Returns the full text including the trailing \r\n\r\n.
async fn read_http_response_head<R: AsyncReadExt + Unpin>(reader: &mut R) -> Result<String, String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];

    loop {
        reader
            .read_exact(&mut byte)
            .await
            .map_err(|e| format!("read response head: {e}"))?;
        buf.push(byte[0]);

        if buf.len() >= 4 && &buf[buf.len() - 4..] == b"\r\n\r\n" {
            return String::from_utf8(buf).map_err(|e| format!("response head utf8: {e}"));
        }
    }
}

/// Build a raw HTTP upgrade request string for WebSocket relay.
fn build_raw_upgrade_request(request: &ParsedProxyRequest) -> Result<String, String> {
    let path = build_request_path(&request.url);
    let mut raw = format!(
        "{} {} HTTP/1.1\r\n",
        request.method,
        path,
    );

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
        raw.push_str(&format!(
            "{}: {}\r\n",
            name,
            value.to_str().unwrap_or("")
        ));
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
    session_sender: mpsc::UnboundedSender<ProxySessionDetail>,
    ws_message_sender: mpsc::UnboundedSender<crate::ws::WsMessageData>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    rewrite_manager: Option<Arc<RewriteManager>>,
    map_manager: Option<Arc<MapManager>>,
    throttle_manager: Option<Arc<ThrottleManager>>,
    workspace_id: String,
    event_emitter: Option<BreakpointEventEmitter>,
) -> Result<(), String> {
    // Send 200 Connection Established
    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(map_io_error)?;

    // TLS handshake
    let tls_acceptor = tokio_rustls::TlsAcceptor::from(tls_manager.server_config.clone());
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

    emit_log(
        "DEBUG",
        "tls_handshake_succeeded",
        &[
            ("host", host.clone()),
            ("port", port.to_string()),
        ],
    );

    let tls_instant = Instant::now();
    let mut tls_stream = tls_stream;

    // Read the decrypted HTTP request from the TLS stream
    let request = match read_proxy_request_from_stream(&mut tls_stream).await {
        Ok(r) => r,
        Err(error) => {
            emit_log(
                "WARN",
                "tls_request_parse_failed",
                &[
                    ("host", host.clone()),
                    ("error", error),
                ],
            );
            return Ok(());
        }
    };

    let tls_ms = tls_instant.elapsed().as_millis();

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
        url: Url::parse(&https_url)
            .map_err(|e| format!("invalid https URL {https_url}: {e}"))?,
        ..request
    };

    let request_runtime = apply_request_runtime_rules(
        &rewrite_manager,
        &map_manager,
        &throttle_manager,
        &workspace_id,
        &mut https_request,
    )?;

    // --- Request-stage breakpoint (HTTPS) ---
    if let Some(resolution) = intercept_request_stage(&breakpoint_manager, &event_emitter, &mut https_request).await? {
        match resolution.action {
            BreakpointActionKind::Drop => {
                let _ = tls_stream.shutdown().await;
                return Ok(());
            }
            BreakpointActionKind::Mock => {
                if let Some(ref mock) = resolution.mock {
                    if let Some(profile) = request_runtime.throttle_profile.as_ref() {
                        if let Err(error) = apply_request_throttle(profile, https_request.body.len()).await {
                            return respond_with_throttle_failure(
                                &mut tls_stream,
                                &https_request,
                                &session_sender,
                                started_at,
                                started_at_instant,
                                Some(tls_ms),
                                &error,
                            )
                            .await;
                        }
                    }

                    let mut mock_response = build_mock_upstream_response(mock);
                    apply_response_rewrite_rules(
                        &rewrite_manager,
                        &workspace_id,
                        &https_request,
                        &mut mock_response,
                    )?;

                    if let Some(profile) = request_runtime.throttle_profile.as_ref() {
                        apply_response_throttle(profile, mock_response.response_body.len()).await;
                    }

                    write_upstream_response(
                        &mut tls_stream,
                        mock_response.status_code,
                        &mock_response.response_headers,
                        &mock_response.response_body,
                    )
                    .await?;

                    let detail = build_session_detail(
                        &https_request,
                        mock_response.status_code.as_u16(),
                        &mock_response.response_headers,
                        &mock_response.response_body,
                        started_at,
                        started_at_instant,
                        ProxyTimingBreakdown {
                            connect_ms: None,
                            dns_ms: None,
                            request_send_ms: Some(0),
                            response_read_ms: Some(0),
                            tls_ms: Some(tls_ms),
                            total_ms: Some(started_at_instant.elapsed().as_millis()),
                            waiting_ms: Some(0),
                        },
                    );
                    if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }
                    return Ok(());
                }
            }
            BreakpointActionKind::Forward => {}
        }
    }

    let pending_detail = build_pending_session_detail(&https_request, started_at);
    let _ = session_sender.send(pending_detail);

    let RequestRuntimeOutcome {
        local_response,
        throttle_profile,
    } = request_runtime;

    if let Some(profile) = throttle_profile.as_ref() {
        if let Err(error) = apply_request_throttle(profile, https_request.body.len()).await {
            return respond_with_throttle_failure(
                &mut tls_stream,
                &https_request,
                &session_sender,
                started_at,
                started_at_instant,
                Some(tls_ms),
                &error,
            )
            .await;
        }
    }

    let upstream_result = match local_response {
        Some(local_response) => Ok(local_response),
        None => {
            // WebSocket upgrade requests must bypass reqwest (which can't handle 101 protocol switch).
            let is_ws = https_request.headers.iter().any(|(name, value)| {
                name.as_str().eq_ignore_ascii_case("upgrade") && value.as_bytes().eq_ignore_ascii_case(b"websocket")
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
                )
                .await?;
                return Ok(());
            }
            forward_request(&client, &https_request).await
        }
    };

    match upstream_result {
        Ok(mut upstream_response) => {
            apply_response_rewrite_rules(
                &rewrite_manager,
                &workspace_id,
                &https_request,
                &mut upstream_response,
            )?;

            // --- Response-stage breakpoint (HTTPS) ---
            let breakpoint_resolution = match intercept_response_stage(
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
                    let detail = build_session_detail(
                        &https_request,
                        upstream_response.status_code.as_u16(),
                        &upstream_response.response_headers,
                        &upstream_response.response_body,
                        started_at,
                        started_at_instant,
                        ProxyTimingBreakdown {
                            connect_ms: None,
                            dns_ms: None,
                            request_send_ms: Some(0),
                            response_read_ms: Some(upstream_response.response_read_ms),
                            tls_ms: Some(tls_ms),
                            total_ms: Some(started_at_instant.elapsed().as_millis()),
                            waiting_ms: Some(upstream_response.waiting_ms),
                        },
                    );
                    if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }
                    return Err(error);
                }
            };

            if let Some(resolution) = breakpoint_resolution {
                match resolution.action {
                    BreakpointActionKind::Drop => {
                        let detail = build_session_detail(
                            &https_request,
                            upstream_response.status_code.as_u16(),
                            &upstream_response.response_headers,
                            &upstream_response.response_body,
                            started_at,
                            started_at_instant,
                            ProxyTimingBreakdown {
                                connect_ms: None,
                                dns_ms: None,
                                request_send_ms: Some(0),
                                response_read_ms: Some(upstream_response.response_read_ms),
                                tls_ms: Some(tls_ms),
                                total_ms: Some(started_at_instant.elapsed().as_millis()),
                                waiting_ms: Some(upstream_response.waiting_ms),
                            },
                        );
                        if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }
                        let _ = tls_stream.shutdown().await;
                        return Ok(());
                    }
                    BreakpointActionKind::Mock => {
                        if let Some(ref mock) = resolution.mock {
                            upstream_response = build_mock_upstream_response(mock);
                        }
                    }
                    BreakpointActionKind::Forward => {
                        apply_response_resolution(&resolution, &mut upstream_response);
                    }
                }
            }

            if let Some(profile) = throttle_profile.as_ref() {
                apply_response_throttle(profile, upstream_response.response_body.len()).await;
            }

            if let Err(error) = write_upstream_response(
                &mut tls_stream,
                upstream_response.status_code,
                &upstream_response.response_headers,
                &upstream_response.response_body,
            )
            .await
            {
                let detail = build_session_detail(
                    &https_request,
                    upstream_response.status_code.as_u16(),
                    &upstream_response.response_headers,
                    &upstream_response.response_body,
                    started_at,
                    started_at_instant,
                    ProxyTimingBreakdown {
                        connect_ms: None,
                        dns_ms: None,
                        request_send_ms: Some(0),
                        response_read_ms: Some(upstream_response.response_read_ms),
                        tls_ms: Some(tls_ms),
                        total_ms: Some(started_at_instant.elapsed().as_millis()),
                        waiting_ms: Some(upstream_response.waiting_ms),
                    },
                );
                if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }
                return Err(error);
            }

            let detail = build_session_detail(
                &https_request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(upstream_response.response_read_ms),
                    tls_ms: Some(tls_ms),
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(upstream_response.waiting_ms),
                },
            );

            if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
                    }

            emit_log(
                "DEBUG",
                "https_request_forwarded",
                &[
                    ("request_id", https_request.request_id.clone()),
                    ("host", host.clone()),
                    ("method", https_request.method.to_string()),
                    ("status_code", upstream_response.status_code.as_u16().to_string()),
                    ("url", https_url),
                ],
            );

            Ok(())
        }
        Err(error) => {
            let response_message = "The proxy could not reach the upstream HTTPS server.";

            write_plain_text_response(
                &mut tls_stream,
                StatusCode::BAD_GATEWAY,
                response_message,
            )
            .await?;

            let detail = build_session_detail(
                &https_request,
                StatusCode::BAD_GATEWAY.as_u16(),
                &HeaderMap::new(),
                response_message.as_bytes(),
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(0),
                    tls_ms: Some(tls_ms),
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(started_at_instant.elapsed().as_millis()),
                },
            );
            if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
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

        let bytes_read = read_result
            .map_err(|error| format!("failed to read from client stream: {error}"))?;

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
        let bytes_read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("failed to read request body: {error}"))?;

        if bytes_read == 0 {
            return Err("client disconnected before request body was fully received".to_string());
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);
    }
    let body = buffer[header_end..header_end + body_length].to_vec();
    let raw_request = build_raw_http_message(
        &format!(
            "{} {} HTTP/1.{}",
            method.as_str(),
            raw_path,
            request_version,
        ),
        &request_headers,
        &body,
    );

    Ok(ParsedProxyRequest {
        body,
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
    let request_url = Url::parse(&url)
        .map_err(|e| format!("invalid URL '{url}': {e}"))?;

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

    let raw_request = build_raw_http_message(
        &format!("{method} {path} HTTP/1.1"),
        &headers,
        &body_bytes,
    );

    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))?;

    let mut request_builder = client.request(request_method.clone(), request_url.clone());
    request_builder = request_builder.headers(header_map.clone());

    if !body_bytes.is_empty() {
        request_builder = request_builder.body(body_bytes.clone());
    }

    let started_at = Utc::now();
    let started_at_instant = Instant::now();

    let waiting_started_at = Instant::now();
    let response = request_builder.send().await.map_err(|e| {
        format!("failed to send request to '{url}': {e}")
    })?;
    let waiting_ms = waiting_started_at.elapsed().as_millis();

    let status_code = response.status();
    let response_headers = response.headers().clone();

    let response_read_started_at = Instant::now();
    let response_body = response
        .bytes()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?
        .to_vec();
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
        size_bytes: response_body.len(),
        response_mime_type,
        started_at,
        started_at_instant,
    });

    let response_body_decoded = decode_body_bytes(
        &response_body,
        response_headers.get(reqwest::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()),
    ).unwrap_or_else(|| response_body.clone());

    Ok(ProxySessionDetail {
        cookies: build_cookie_entries(&headers, &response_header_entries),
        id,
        query_params,
        raw_request: Some(raw_request),
        raw_response: Some(build_raw_http_message(
            &format!(
                "HTTP/1.1 {} {}",
                status_code.as_u16(),
                status_code.canonical_reason().unwrap_or("Unknown"),
            ),
            &response_header_entries,
            &response_body_decoded,
        )),
        request_body: build_body_reference(
            &body_bytes,
            header_map.get(CONTENT_TYPE),
            header_map.get(reqwest::header::CONTENT_ENCODING),
        ),
        request_headers: headers,
        response_body: build_body_reference(
            &response_body,
            response_headers.get(CONTENT_TYPE),
            response_headers.get(reqwest::header::CONTENT_ENCODING),
        ),
        response_headers: response_header_entries,
        server_ip: None,
        summary,
        timing: Some(timing),
    })
}

async fn respond_with_throttle_failure<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    request: &ParsedProxyRequest,
    session_sender: &mpsc::UnboundedSender<ProxySessionDetail>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    tls_ms: Option<u128>,
    error: &str,
) -> Result<(), String> {
    let response_message = "The request was dropped by the active throttle profile.";

    write_plain_text_response(stream, StatusCode::GATEWAY_TIMEOUT, response_message).await?;

    let detail = build_session_detail(
        request,
        StatusCode::GATEWAY_TIMEOUT.as_u16(),
        &HeaderMap::new(),
        response_message.as_bytes(),
        started_at,
        started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: Some(0),
            response_read_ms: Some(0),
            tls_ms,
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(started_at_instant.elapsed().as_millis()),
        },
    );
    if session_sender.send(detail).is_err() {
                        emit_log("DEBUG", "session_send_dropped", &[("reason", "receiver_disconnected".to_string())]);
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
