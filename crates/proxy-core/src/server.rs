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
) -> Result<(), String> {
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
                return tunnel_blind_relay(
                    prefixed,
                    &host,
                    port,
                    &dns_manager,
                    &active_workspace_id,
                )
                .await;
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
                return handle_connect_mitm(
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
    });

    let service = HttpProxyService { ctx };
    let mut prefix = consumed;
    prefix.extend_from_slice(&leftover);
    let io = hyper_util::rt::TokioIo::new(OwnedPrefixedStream::new(prefix, stream));

    hyper::server::conn::http1::Builder::new()
        .serve_connection(io, service)
        .with_upgrades()
        .await
        .map_err(|e| format!("HTTP/1.1 server error: {e}"))?;

    Ok(())
}
pub(crate) async fn forward_request(
    request: &ParsedProxyRequest,
    dns_manager: &Option<Arc<DnsManager>>,
    workspace_id: &str,
    pool: Option<Arc<crate::upstream_pool::UpstreamConnectionPool>>,
) -> Result<UpstreamResponse, ProxyError> {
    use http_body_util::BodyExt;

    tracing::info!(
        event = "upstream_request_started",
        request_id = %request.request_id,
        method = %request.method,
        scheme = %request.url.scheme(),
        host = %request.host,
        url = %request.url,
        "upstream_request_started"
    );

    let dns_override_ip = resolve_dns_override(dns_manager, workspace_id, &request.host);
    if let Some(ip) = &dns_override_ip {
        tracing::info!(
            event = "dns_override_applied",
            host = %request.host,
            override_ip = %ip,
            "dns_override_applied"
        );
    }

    // --- Try h2 connection pool for HTTPS requests ---
    let is_https = request.url.scheme() == "https";
    let pool_result = if is_https {
        if let Some(ref p) = pool {
            let key = crate::upstream_pool::UpstreamKey {
                host: request.host.clone(),
                port: request.url.port().unwrap_or(443),
            };
            Some(p.get_or_connect(&key, dns_override_ip).await?)
        } else {
            None
        }
    } else {
        None
    };

    // Build the request-target (path + query) for the HTTP request line.
    let request_target = if request.url.query().is_some() {
        format!(
            "{}?{}",
            request.url.path(),
            request.url.query().unwrap_or("")
        )
    } else {
        request.url.path().to_string()
    };

    // Build an http::Request with the original Host header (not DNS override IP).
    let mut http_req_builder = http::Request::builder()
        .method(request.method.clone())
        .uri(&request_target);

    // Copy request headers.
    for (name, value) in &request.headers {
        if let Ok(v) = value.to_str() {
            http_req_builder = http_req_builder.header(name.as_str(), v);
        }
    }
    // Ensure Host header matches the original request host.
    let host_header = match request.url.port() {
        Some(port) => format!("{}:{port}", request.host),
        None => request.host.clone(),
    };
    http_req_builder = http_req_builder.header("host", &host_header);

    let (mut sender, connection_timing) = if let Some(Some((mut h2_sender, timing))) = pool_result {
        // Pooled h2 path — reuse the cached connection.
        let timing = timing.unwrap_or_else(|| crate::timing_connector::ConnectionTiming {
            dns_ms: 0,
            connect_ms: 0,
            tls_ms: None,
            alpn_protocol: Some("h2".to_string()),
        });
        let http_req = if request.body.is_empty() {
            http_req_builder
                .body::<http_body_util::combinators::BoxBody<bytes::Bytes, String>>(
                    http_body_util::Empty::new()
                        .map_err(|_: std::convert::Infallible| unreachable!())
                        .boxed(),
                )
                .map_err(|e| {
                    ProxyError::UpstreamError(format!("failed to build upstream request: {e}"))
                })?
        } else {
            http_req_builder
                .body::<http_body_util::combinators::BoxBody<bytes::Bytes, String>>(
                    http_body_util::Full::new(bytes::Bytes::from(request.body.clone()))
                        .map_err(|_: std::convert::Infallible| unreachable!())
                        .boxed(),
                )
                .map_err(|e| {
                    ProxyError::UpstreamError(format!("failed to build upstream request body: {e}"))
                })?
        };

        // send_request + read
        let waiting_started_at = Instant::now();
        let response = match h2_sender.send_request(http_req).await {
            Ok(r) => r,
            Err(error) => {
                // Evict stale connection from pool and report failure.
                if let Some(ref p) = pool {
                    let key = crate::upstream_pool::UpstreamKey {
                        host: request.host.clone(),
                        port: request.url.port().unwrap_or(443),
                    };
                    p.evict_key(&key).await;
                }
                tracing::error!(
                    event = "upstream_request_send_failed",
                    request_id = %request.request_id,
                    method = %request.method,
                    scheme = %request.url.scheme(),
                    host = %request.host,
                    url = %request.url,
                    error = %error,
                    "upstream_request_send_failed"
                );
                return Err(ProxyError::UpstreamError(format!(
                    "failed to send upstream h2 request: {error}"
                )));
            }
        };
        let waiting_ms = waiting_started_at.elapsed().as_millis();

        return build_upstream_response_from_hyper(response, request, timing, waiting_ms).await;
    } else {
        // h1 path — establish a new connection per request.
        let mut connector = crate::timing_connector::create_timing_connector(dns_override_ip);
        let uri: http::Uri = request.url.to_string().parse().map_err(|e| {
            ProxyError::UpstreamError(format!(
                "failed to parse upstream URL '{}' as URI: {e}",
                request.url
            ))
        })?;
        let (timing_stream, connection_timing) = tower_service::Service::call(&mut connector, uri)
            .await
            .map_err(|error| {
                tracing::error!(
                    event = "upstream_connect_failed",
                    request_id = %request.request_id,
                    host = %request.host,
                    url = %request.url,
                    error = %error,
                    "upstream_connect_failed"
                );
                ProxyError::UpstreamError(format!("failed to connect to upstream: {error}"))
            })?;

        let (sender, conn) = hyper::client::conn::http1::handshake(timing_stream)
            .await
            .map_err(|error| {
                tracing::error!(
                    event = "upstream_http_handshake_failed",
                    request_id = %request.request_id,
                    host = %request.host,
                    error = %error,
                    "upstream_http_handshake_failed"
                );
                ProxyError::UpstreamError(format!("upstream HTTP handshake failed: {error}"))
            })?;

        tokio::spawn(async move {
            let _ = conn.await;
        });

        (sender, connection_timing)
    };

    let http_req = if request.body.is_empty() {
        http_req_builder
            .body::<http_body_util::combinators::BoxBody<bytes::Bytes, std::convert::Infallible>>(
                http_body_util::Empty::new()
                    .map_err(|_: std::convert::Infallible| unreachable!())
                    .boxed(),
            )
            .map_err(|e| format!("failed to build upstream request: {e}"))?
    } else {
        http_req_builder
            .body::<http_body_util::combinators::BoxBody<bytes::Bytes, std::convert::Infallible>>(
                http_body_util::Full::new(bytes::Bytes::from(request.body.clone()))
                    .map_err(|_: std::convert::Infallible| unreachable!())
                    .boxed(),
            )
            .map_err(|e| format!("failed to build upstream request body: {e}"))?
    };

    // send_request().await bundles socket-write + server-think into one call,
    // so we cannot truly separate "send" from "wait".  Measure the combined
    // duration as waiting_ms and leave request_send_ms at 0 until we have a
    // streaming send API that can report flush completion.
    let waiting_started_at = Instant::now();
    let response = sender.send_request(http_req).await.map_err(|error| {
        tracing::error!(
            event = "upstream_request_send_failed",
            request_id = %request.request_id,
            method = %request.method,
            scheme = %request.url.scheme(),
            host = %request.host,
            url = %request.url,
            error = %error,
            "upstream_request_send_failed"
        );
        ProxyError::UpstreamError(format!("failed to send upstream request: {error}"))
    })?;
    let waiting_ms = waiting_started_at.elapsed().as_millis();

    build_upstream_response_from_hyper(response, request, connection_timing, waiting_ms).await
}

/// Build an `UpstreamResponse` from a hyper response, reading the body and
/// extracting timing information.
async fn build_upstream_response_from_hyper(
    response: hyper::Response<hyper::body::Incoming>,
    request: &ParsedProxyRequest,
    connection_timing: crate::timing_connector::ConnectionTiming,
    waiting_ms: u128,
) -> Result<UpstreamResponse, ProxyError> {
    let status_code =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

    // Collect response headers.
    let mut response_headers = HeaderMap::new();
    for (name, value) in response.headers() {
        if let Ok(header_name) = HeaderName::from_bytes(name.as_str().as_bytes()) {
            response_headers.append(header_name, value.clone());
        }
    }

    // Read full response body.
    let response_read_started_at = Instant::now();
    let (response_body, response_body_size_bytes, body_truncated, spooled_response_path) =
        read_hyper_response_body_with_limit(response, &request.request_id, true)
            .await
            .map_err(|error| {
                tracing::error!(
                    event = "upstream_response_read_failed",
                    request_id = %request.request_id,
                    method = %request.method,
                    scheme = %request.url.scheme(),
                    host = %request.host,
                    url = %request.url,
                    status_code = status_code.as_u16(),
                    error = %error,
                    "upstream_response_read_failed"
                );
                ProxyError::UpstreamError(format!("failed to read upstream response body: {error}"))
            })?;
    let response_read_ms = response_read_started_at.elapsed().as_millis();

    tracing::info!(
        event = "upstream_request_succeeded",
        request_id = %request.request_id,
        method = %request.method,
        scheme = %request.url.scheme(),
        host = %request.host,
        url = %request.url,
        status_code = status_code.as_u16(),
        dns_ms = connection_timing.dns_ms,
        connect_ms = connection_timing.connect_ms,
        tls_ms = %connection_timing.tls_ms.map_or_else(|| "n/a".to_string(), |v| v.to_string()),
        waiting_ms = waiting_ms,
        response_read_ms = response_read_ms,
        "upstream_request_succeeded"
    );

    Ok(UpstreamResponse {
        body_truncated,
        connect_ms: connection_timing.connect_ms,
        dns_ms: connection_timing.dns_ms,
        request_send_ms: 0,
        response_body,
        response_body_size_bytes,
        response_headers,
        response_read_ms,
        spooled_response_path,
        status_code,
        tls_ms: connection_timing.tls_ms,
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
        tracing::warn!(
            event = "response_body_truncated",
            request_id = %request_id,
            original_size = response_body_size_bytes,
            captured_size = MAX_CAPTURED_BODY_BYTES,
            spooled = preserve_full_body,
            "response_body_truncated"
        );
    }

    Ok((
        response_body,
        response_body_size_bytes,
        body_truncated,
        spooled_response_path,
    ))
}

/// Read the full body from a hyper Response, with spool-to-disk for large bodies.
async fn read_hyper_response_body_with_limit(
    response: hyper::Response<hyper::body::Incoming>,
    request_id: &str,
    preserve_full_body: bool,
) -> Result<(Vec<u8>, usize, bool, Option<PathBuf>), String> {
    use http_body_util::BodyExt;

    let mut response_body = Vec::new();
    let mut response_body_size_bytes = 0usize;
    let mut body_truncated = false;
    let mut spooled_response_path = None;
    let mut spooled_file: Option<tokio::fs::File> = None;

    let mut body_stream = std::pin::pin!(response.into_body());

    while let Some(frame_result) = body_stream.frame().await {
        let frame = frame_result.map_err(|error| format!("read hyper response frame: {error}"))?;

        let chunk = match frame.into_data() {
            Ok(data) => data,
            Err(_) => continue, // Skip trailers
        };

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
        tracing::warn!(
            event = "response_body_truncated",
            request_id = %request_id,
            original_size = response_body_size_bytes,
            captured_size = MAX_CAPTURED_BODY_BYTES,
            spooled = preserve_full_body,
            "response_body_truncated"
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

/// Blind TCP relay for CONNECT when SSL interception is disabled.
async fn tunnel_blind_relay<S: AsyncRead + AsyncWrite + Unpin>(
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

    // Bidirectional copy via tokio::io::split (works with any AsyncRead + AsyncWrite).
    let (mut cr, mut cw) = tokio::io::split(&mut client_stream);
    let (mut ur, mut uw) = tokio::io::split(&mut upstream);

    let client_to_upstream = tokio::io::copy(&mut cr, &mut uw);
    let upstream_to_client = tokio::io::copy(&mut ur, &mut cw);

    tokio::select! {
        r = client_to_upstream => {
            if let Err(e) = r {
                tracing::warn!(event = "tunnel_client_to_upstream_error", error = %e, "tunnel_client_to_upstream_error");
            }
        }
        r = upstream_to_client => {
            if let Err(e) = r {
                tracing::warn!(event = "tunnel_upstream_to_client_error", error = %e, "tunnel_upstream_to_client_error");
            }
        }
    }

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
async fn handle_connect_mitm<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
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
            tracing::warn!(
                event = "tls_handshake_failed",
                host = %host,
                port = port,
                error = %error,
                "tls_handshake_failed"
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
                format!("HTTP/2 server connection error for {host}:{port}: {e}")
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
                format!("HTTP/1.1 server connection error for {host}:{port}: {e}")
            })?;
    }

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
