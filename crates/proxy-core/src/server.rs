use super::*;

static DIRECT_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn direct_http_client() -> Result<Client, String> {
    if let Some(client) = DIRECT_HTTP_CLIENT.get() {
        return Ok(client.clone());
    }

    // Bound the TCP connect phase so a hanging connect cannot block forever.
    // The full request/response timeout is enforced per-call in
    // send_direct_request via tokio::time::timeout (which respects the test
    // override), so we only set connect_timeout here to keep the static client
    // reusable across runs.
    let connect_timeout = crate::upstream_request_timeout();
    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(connect_timeout)
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))?;
    let _ = DIRECT_HTTP_CLIENT.set(client);

    DIRECT_HTTP_CLIENT
        .get()
        .cloned()
        .ok_or_else(|| "failed to initialize HTTP client".to_string())
}

pub async fn start_proxy_server(
    config: ProxyConfig,
    managers: ProxyManagers,
) -> Result<StartedProxyServer, String> {
    config.runtime.validate().map_err(str::to_string)?;

    let bind_addr: &str = DEFAULT_BIND_ADDRESS;
    let listener = TcpListener::bind((bind_addr, config.runtime.port))
        .await
        .map_err(|error| format_listener_bind_error(bind_addr, config.runtime.port, &error))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| format!("failed to read proxy listener address: {error}"))?
        .port();

    let (shutdown_sender, mut shutdown_receiver) = oneshot::channel::<()>();
    let (session_sender, session_receiver) = mpsc::channel(4096);
    let (ws_message_sender, ws_message_receiver) = mpsc::channel(4096);
    let connection_semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
    let upstream_pool = Arc::new(crate::upstream_pool::UpstreamConnectionPool::new());
    // Start background eviction of stale pooled connections every 60s.
    {
        let pool = Arc::clone(&upstream_pool);
        pool.start_eviction_timer(
            std::time::Duration::from_secs(60),
            std::time::Duration::from_secs(120),
        );
    }

    tracing::info!(
        event = "listener_started",
        host = %bind_addr,
        port = bound_port,
        ssl_enabled = config.runtime.ssl_enabled,
        max_connections = MAX_CONCURRENT_CONNECTIONS,
        "listener_started"
    );

    let join_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_receiver => {
                    tracing::info!(
                        event = "listener_stopped",
                        reason = "shutdown_requested",
                        "listener_stopped"
                    );
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, client_addr)) => {
                            let permit = match connection_semaphore.clone().try_acquire_owned() {
                                Ok(permit) => permit,
                                Err(_) => {
                                    tracing::warn!(
                                        event = "connection_rejected",
                                        client_addr = %client_addr,
                                        reason = "max_connections_reached",
                                        "connection_rejected"
                                    );
                                    continue;
                                }
                            };

                            let session_sender = session_sender.clone();
                            let ws_message_sender = ws_message_sender.clone();
                            let managers = managers.clone();
                            let config = config.clone();
                            let upstream_pool = upstream_pool.clone();

                            tokio::spawn(async move {
                                let _permit = permit;
                                if let Err(error) = handle_connection(
                                    stream,
                                    client_addr,
                                    session_sender,
                                    ws_message_sender,
                                    managers,
                                    config,
                                    upstream_pool,
                                )
                                .await
                                {
                                    tracing::error!(
                                        event = "connection_failed",
                                        client_addr = %client_addr,
                                        error = %error,
                                        "connection_failed"
                                    );
                                }
                            });
                        }
                        Err(error) => {
                            tracing::error!(
                                event = "listener_accept_failed",
                                error = %error,
                                "listener_accept_failed"
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
    use super::Url;

    #[test]
    fn serializes_port_in_use_bind_failures_as_app_errors() {
        let error = std::io::Error::new(std::io::ErrorKind::AddrInUse, "Address already in use");
        let actual = format_listener_bind_error("127.0.0.1", 8888, &error);
        let parsed: serde_json::Value = serde_json::from_str(&actual).expect("valid json");

        assert_eq!(parsed["code"], "PORT_IN_USE");
        assert_eq!(parsed["details"]["port"], 8888);
        assert_eq!(parsed["details"]["host"], "127.0.0.1");
    }

    // -----------------------------------------------------------------------
    // CONNECT port parsing from URL
    // -----------------------------------------------------------------------

    #[test]
    fn connect_port_parsed_from_url() {
        // CONNECT target "example.com:8443" is parsed as "http://example.com:8443"
        // by read_proxy_request. Verify that url::Url extracts the custom port.
        let raw_path = "example.com:8443";
        let target_url = format!("http://{raw_path}");
        let url = Url::parse(&target_url).expect("valid URL");

        assert_eq!(url.port(), Some(8443));
        assert_eq!(url.host_str(), Some("example.com"));
    }

    #[test]
    fn connect_default_port_when_absent() {
        let raw_path = "example.com";
        let target_url = format!("http://{raw_path}");
        let url = Url::parse(&target_url).expect("valid URL");

        // No explicit port → url::Url returns None, proxy falls back to 443.
        assert_eq!(url.port(), None);
        assert_eq!(
            url.port().unwrap_or(super::DEFAULT_HTTPS_PORT),
            super::DEFAULT_HTTPS_PORT
        );
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    client_addr: SocketAddr,
    session_sender: mpsc::Sender<ProxySessionDetail>,
    ws_message_sender: mpsc::Sender<crate::ws::WsMessageData>,
    managers: ProxyManagers,
    config: ProxyConfig,
    upstream_pool: Arc<crate::upstream_pool::UpstreamConnectionPool>,
) -> Result<(), ProxyError> {
    let ProxyManagers {
        tls: tls_manager,
        breakpoint: breakpoint_manager,
        rewrite: rewrite_manager,
        map: map_manager,
        script: script_manager,
        throttle: throttle_manager,
        dns: dns_manager,
    } = managers;
    let workspace_id = config.workspace_id;
    let event_emitter = config.event_emitter;
    // H3: upstream TLS verification mode + per-host allowlist for this proxy
    // instance. The connector ORs the global flag with allowlist membership
    // per connection.
    let verify_upstream_tls = config.runtime.verify_upstream_tls;
    let tls_verify_hosts = Arc::clone(&config.runtime.tls_verify_hosts);

    // Header-only probe — reads until \r\n\r\n, returns (request, consumed, leftover).
    // consumed = full header bytes up to and including \r\n\r\n.
    // leftover = bytes accidentally read past the header (body/TLS ClientHello).
    let (mut request, consumed, leftover) = match read_header_only(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            write_plain_text_response(
                &mut stream,
                StatusCode::BAD_REQUEST,
                "Unable to parse the HTTP proxy request.",
            )
            .await?;

            tracing::warn!(
                event = "request_parse_failed",
                client_addr = %client_addr,
                error = %error,
                "request_parse_failed"
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
            tracing::info!(
                event = "cert_served",
                client_addr = %client_addr,
                path = %request.path,
                "cert_served"
            );

            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/x-x509-ca-cert\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                cert_pem.len(),
                cert_pem
            );
            stream
                .write_all(response.as_bytes())
                .await
                .map_err(ProxyError::IoError)?;
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
        let port = request.url.port().unwrap_or(DEFAULT_HTTPS_PORT);

        tracing::debug!(
            event = "connect_received",
            request_id = %request.request_id,
            client_addr = %client_addr,
            host = %host,
            port = port,
            ssl_interception_enabled = tls_manager.is_some(),
            "connect_received"
        );

        // Replay ONLY leftover (TLS ClientHello bytes) into the stream.
        // TLS acceptor must NOT see the CONNECT request header.
        let prefixed = OwnedPrefixedStream::new(leftover, stream);

        match tls_manager {
            None => {
                tracing::warn!(
                    event = "connect_tunneling_without_mitm",
                    request_id = %request.request_id,
                    client_addr = %client_addr,
                    host = %host,
                    port = port,
                    "connect_tunneling_without_mitm"
                );

                // No TLS manager — blind tunnel (no decryption)
                return crate::connect::tunnel_blind_relay(
                    prefixed,
                    &host,
                    port,
                    &dns_manager,
                    &active_workspace_id,
                )
                .await
                .map_err(ProxyError::from);
            }
            Some(mgr) => {
                tracing::debug!(
                    event = "connect_mitm_started",
                    request_id = %request.request_id,
                    client_addr = %client_addr,
                    host = %host,
                    port = port,
                    "connect_mitm_started"
                );

                // MITM: TLS terminate, capture, forward
                return crate::connect::handle_connect_mitm(
                    prefixed,
                    host,
                    port,
                    mgr,
                    client_addr,
                    session_sender,
                    ws_message_sender,
                    breakpoint_manager,
                    rewrite_manager,
                    map_manager,
                    script_manager,
                    throttle_manager,
                    dns_manager,
                    active_workspace_id,
                    event_emitter,
                    upstream_pool,
                    verify_upstream_tls,
                    Arc::clone(&tls_verify_hosts),
                )
                .await;
            }
        }
    }

    // === Non-CONNECT: hand off to hyper server ===
    // hyper needs the COMPLETE HTTP request — replay consumed + leftover.
    let ctx = Arc::new(ConnectionContext {
        mode: ConnectionMode::PlainHttp,
        client_addr,
        session_sender,
        ws_message_sender,
        rewrite_manager,
        map_manager,
        script_manager,
        throttle_manager,
        breakpoint_manager,
        dns_manager,
        workspace_id: active_workspace_id,
        event_emitter,
        upstream_pool,
        verify_upstream_tls,
        tls_verify_hosts,
    });

    let service = HttpProxyService { ctx };
    let mut prefix = consumed;
    prefix.extend_from_slice(&leftover);
    let io = hyper_util::rt::TokioIo::new(OwnedPrefixedStream::new(prefix, stream));

    hyper::server::conn::http1::Builder::new()
        .serve_connection(io, service)
        .with_upgrades()
        .await
        .map_err(|e| ProxyError::Other(format!("HTTP/1.1 server error: {e}")))?;

    Ok(())
}

/// Header-only probe to detect CONNECT / CA cert requests.
///
/// Reads from the stream until `\r\n\r\n` is found, then parses the
/// request line and headers via httparse. Does NOT read the body.
///
/// Returns:
/// - `request`  — ParsedProxyRequest with method, path, URL, headers (body is empty)
/// - `consumed`  — all raw bytes read up to and including `\r\n\r\n`
/// - `leftover` — any bytes read PAST the header terminator (body prefix,
///   TLS ClientHello for CONNECT, etc.)
///
/// The caller MUST replay the appropriate bytes via PrefixedStream:
///   - CONNECT / MITM / tunnel: replay only `leftover`
///   - Non-CONNECT (hyper): replay `[consumed, leftover].concat()`
///   - CA cert: neither is replayed — `stream` is used directly, then closed.
async fn read_header_only<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
) -> Result<(ParsedProxyRequest, Vec<u8>, Vec<u8>), String> {
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

    let (method, raw_path, url, header_map, request_headers, host, path, protocol, query_params) = {
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
        let header_map = build_upstream_headers(request.headers)?;
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

        (
            method,
            raw_path,
            url,
            header_map,
            request_headers,
            host,
            path,
            protocol,
            query_params,
        )
    };

    let consumed = buffer[..header_end].to_vec();
    let leftover = if buffer.len() > header_end {
        buffer[header_end..].to_vec()
    } else {
        Vec::new()
    };

    // Build minimal raw_request for logging/display.
    let request_version = request.version.unwrap_or(1);
    let raw_request = build_raw_http_head(
        &format!(
            "{} {} HTTP/1.{}",
            method.as_str(),
            raw_path,
            request_version,
        ),
        &request_headers,
    );

    let parsed = ParsedProxyRequest {
        body: Vec::new(),
        client_address: None,
        headers: header_map,
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
    };

    Ok((parsed, consumed, leftover))
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
        // Strip h2 pseudo-headers (`:method`, `:path`, `:scheme`, `:authority`)
        // carried in from replayed/composed h2 sessions. They are illegal as
        // HTTP/1.1 header names (rejected by `HeaderName::from_bytes` below) and
        // redundant with the method/URL set above. Mirrors
        // `build_upstream_headers_from_hyper`.
        if is_pseudo_header_name(&header.name) {
            continue;
        }
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

    // Bound the upstream send + response so a hanging upstream (TCP open but
    // no response, or a slow body) cannot block the Compose/Replay command
    // forever. The test override flows through upstream_request_timeout().
    let upstream_timeout = crate::upstream_request_timeout();
    let timeout_secs = upstream_timeout.as_secs();

    let waiting_started_at = Instant::now();
    let response = match tokio::time::timeout(upstream_timeout, request_builder.send()).await {
        Ok(result) => result.map_err(|e| format!("failed to send request to '{url}': {e}"))?,
        Err(_) => {
            tracing::warn!(
                event = "direct_request_timed_out",
                request_id = %request_id,
                url = %url,
                timeout_secs,
                stage = "send",
                "direct_request_timed_out"
            );
            return Err(format!(
                "upstream '{url}' did not respond within {timeout_secs}s."
            ));
        }
    };
    let waiting_ms = waiting_started_at.elapsed().as_millis();

    let status_code = response.status();
    let response_headers = response.headers().clone();

    let response_read_started_at = Instant::now();
    let (response_body, response_body_size_bytes, body_truncated, _) = match tokio::time::timeout(
        upstream_timeout,
        crate::upstream::read_response_body_with_limit(response, &request_id, false),
    )
    .await
    {
        Ok(result) => result.map_err(|error| format!("failed to read response body: {error}"))?,
        Err(_) => {
            tracing::warn!(
                event = "direct_request_timed_out",
                request_id = %request_id,
                url = %url,
                timeout_secs,
                stage = "body_read",
                "direct_request_timed_out"
            );
            return Err(format!(
                "upstream '{url}' stopped sending the response body within {timeout_secs}s."
            ));
        }
    };
    let response_read_ms = response_read_started_at.elapsed().as_millis();

    tracing::debug!(
        event = "direct_request_completed",
        request_id = %request_id,
        method = %method,
        url = %url,
        status_code = status_code.as_u16(),
        waiting_ms = waiting_ms,
        response_read_ms = response_read_ms,
        "direct_request_completed"
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
            header_map.get(CONTENT_ENCODING),
            body_bytes.len(),
            false,
        ),
        request_headers: headers,
        response_body: build_body_reference(
            &response_body,
            response_headers.get(CONTENT_TYPE),
            response_headers.get(CONTENT_ENCODING),
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
        timing_source: Some("compose".to_string()),
        trailers: None,
        h2_stream_id: None,
    })
}
