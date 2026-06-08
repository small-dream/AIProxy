use super::*;
use crate::MAX_CAPTURED_BODY_BYTES;

// ---------------------------------------------------------------------------
// Upstream request forwarding & response handling
// ---------------------------------------------------------------------------

/// Forward a parsed proxy request to the upstream server and return the
/// full response (status, headers, body, timing).
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

/// Read the full body from a reqwest Response, with spool-to-disk for large bodies.
pub(crate) async fn read_response_body_with_limit(
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
