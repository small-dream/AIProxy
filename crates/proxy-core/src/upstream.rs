use super::*;
use crate::MAX_CAPTURED_BODY_BYTES;

// Test-only instrumentation that tracks how many h1 conn-driver tasks are
// currently alive. The leak being fixed (H5) is an orphaned *task* (not just a
// half-open socket): on a timed-out request the spawned driver used to keep
// running until the peer FINs. Without observing task lifetime directly this
// is invisible, so we expose a counter for the regression test below.
#[cfg(test)]
static H1_ACTIVE_CONN_DRIVERS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
static H1_CONN_DRIVER_NATURAL_COMPLETIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
static H1_CONN_DRIVER_ABORTS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn h1_active_conn_drivers_for_test() -> usize {
    H1_ACTIVE_CONN_DRIVERS.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(test)]
pub(crate) fn h1_conn_driver_completion_breakdown_for_test() -> (usize, usize) {
    (
        H1_CONN_DRIVER_NATURAL_COMPLETIONS.load(std::sync::atomic::Ordering::SeqCst),
        H1_CONN_DRIVER_ABORTS.load(std::sync::atomic::Ordering::SeqCst),
    )
}

/// RAII guard that aborts a spawned h1 connection-driver task on drop, unless
/// explicitly disarmed on the success path.
///
/// The h1 conn driver (`hyper::client::conn::http1::Connection`) is spawned so
/// it can drive the response body independently of the request future. If the
/// request future is dropped early — most importantly when the
/// `upstream_request_timeout` wrapper in `http_proxy.rs` elapses and drops the
/// `forward_request` future — the driver must be aborted, otherwise it keeps
/// the underlying TCP socket open (waiting on the peer) and leaks a task plus a
/// file descriptor on every timed-out request.
///
/// `disarm()` must be called exactly once on the normal success path to let the
/// driver run to completion; any other drop (error return, panic, timeout-drop)
/// aborts the driver and releases the socket promptly.
struct ConnDriverAbortOnDrop(Option<tokio::task::JoinHandle<()>>);

impl ConnDriverAbortOnDrop {
    /// Consume the guard without aborting, returning the handle for the caller
    /// to optionally keep alive. On the success path we simply drop the handle:
    /// the task becomes detached and runs to its natural completion.
    fn disarm(mut self) -> Option<tokio::task::JoinHandle<()>> {
        self.0.take()
    }
}

impl Drop for ConnDriverAbortOnDrop {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
            // The aborted task body never runs to completion, so it will not
            // decrement the active-driver counter itself — do it here to keep
            // the test counter accurate on the leak path.
            #[cfg(test)]
            {
                H1_ACTIVE_CONN_DRIVERS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                H1_CONN_DRIVER_ABORTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            tracing::debug!(
                event = "upstream_h1_conn_driver_aborted",
                "aborted leaked h1 conn driver on early request drop"
            );
        }
    }
}

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

    // Holds the h1 conn-driver abort guard. The h2 pool branch always returns
    // early below, so by the time we reach the shared send/read path this is
    // initialized on the h1 path (and unused on h2).
    let _conn_driver_guard: ConnDriverAbortOnDrop;

    let (mut sender, connection_timing) = if let Some(Some((mut h2_sender, timing))) = pool_result {
        // Pooled h2 path — reuse the cached connection.
        let timing = timing.unwrap_or_else(|| crate::timing_connector::ConnectionTiming {
            dns_ms: 0,
            connect_ms: 0,
            tls_ms: None,
            alpn_protocol: Some("h2".to_string()),
        });

        // Factory that rebuilds the h2 request from scratch each call, so it can
        // be used for both the initial send and a single retry (M3). The h1
        // branch below still uses the shared `http_req_builder` since it sends
        // exactly once.
        let build_h2_req = || -> Result<http::Request<http_body_util::combinators::BoxBody<bytes::Bytes, String>>, ProxyError> {
            let mut builder = http::Request::builder()
                .method(request.method.clone())
                .uri(&request_target);
            for (name, value) in &request.headers {
                if let Ok(v) = value.to_str() {
                    builder = builder.header(name.as_str(), v);
                }
            }
            let host_header = match request.url.port() {
                Some(port) => format!("{}:{port}", request.host),
                None => request.host.clone(),
            };
            builder = builder.header("host", &host_header);
            if request.body.is_empty() {
                builder
                    .body::<http_body_util::combinators::BoxBody<bytes::Bytes, String>>(
                        http_body_util::Empty::new()
                            .map_err(|_: std::convert::Infallible| unreachable!())
                            .boxed(),
                    )
                    .map_err(|e| {
                        ProxyError::UpstreamError(format!("failed to build upstream request: {e}"))
                    })
            } else {
                builder
                    .body::<http_body_util::combinators::BoxBody<bytes::Bytes, String>>(
                        http_body_util::Full::new(bytes::Bytes::from(request.body.clone()))
                            .map_err(|_: std::convert::Infallible| unreachable!())
                            .boxed(),
                    )
                    .map_err(|e| {
                        ProxyError::UpstreamError(format!(
                            "failed to build upstream request body: {e}"
                        ))
                    })
            }
        };

        let pool_key = crate::upstream_pool::UpstreamKey {
            host: request.host.clone(),
            port: request.url.port().unwrap_or(443),
        };

        // send_request + read
        let waiting_started_at = Instant::now();
        let response = match h2_sender.send_request(build_h2_req()?).await {
            Ok(r) => r,
            Err(error) => {
                // M3: the pooled connection is likely half-open (the local side
                // hasn't observed the peer's RST/FIN). Evict it. For safe/
                // idempotent methods we also retry ONCE on a freshly established
                // pooled connection so a stale pooled entry doesn't surface as a
                // spurious 502 for the first request after an idle period. We do
                // NOT retry non-idempotent methods (POST/PUT/PATCH) because the
                // upstream may already be processing the original request even
                // though the stream errored.
                if let Some(ref p) = pool {
                    p.evict_key(&pool_key).await;
                }
                let is_idempotent = matches!(
                    request.method.as_ref(),
                    "GET" | "HEAD" | "OPTIONS" | "DELETE" | "TRACE"
                );
                if !is_idempotent {
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
                tracing::warn!(
                    event = "upstream_request_send_failed_retrying",
                    request_id = %request.request_id,
                    method = %request.method,
                    host = %request.host,
                    url = %request.url,
                    error = %error,
                    "upstream_request_send_failed_retrying"
                );
                let retry_sender = match pool
                    .as_ref()
                    .map(|p| p.get_or_connect(&pool_key, dns_override_ip))
                {
                    Some(fut) => fut.await.map_err(|e| {
                        ProxyError::UpstreamError(format!(
                            "failed to reconnect on retry: {e}"
                        ))
                    })?,
                    None => None,
                };
                match retry_sender {
                    Some((mut fresh_sender, _)) => match fresh_sender
                        .send_request(build_h2_req()?)
                        .await
                    {
                        Ok(r) => r,
                        Err(retry_error) => {
                            if let Some(ref p) = pool {
                                p.evict_key(&pool_key).await;
                            }
                            return Err(ProxyError::UpstreamError(format!(
                                "failed to send upstream h2 request after retry: {retry_error}"
                            )));
                        }
                    },
                    None => {
                        return Err(ProxyError::UpstreamError(format!(
                            "failed to send upstream h2 request: {error}"
                        )));
                    }
                }
            }
        };
        let waiting_ms = waiting_started_at.elapsed().as_millis();

        // Read the response body. M2: a body-read error mid-stream (RST_STREAM,
        // the pooled connection dying during the body) must also evict the key —
        // otherwise the next request to this host reuses the now-broken pooled
        // connection and fails again. (On the h1 path every request gets a fresh
        // connection, so this only matters for the pooled h2 path.)
        let result =
            build_upstream_response_from_hyper(response, request, timing, waiting_ms).await;
        if let Err(error) = &result {
            if let Some(ref p) = pool {
                let key = crate::upstream_pool::UpstreamKey {
                    host: request.host.clone(),
                    port: request.url.port().unwrap_or(443),
                };
                p.evict_key(&key).await;
            }
            tracing::error!(
                event = "upstream_response_read_failed",
                request_id = %request.request_id,
                method = %request.method,
                scheme = %request.url.scheme(),
                host = %request.host,
                url = %request.url,
                error = %error,
                "upstream_response_read_failed"
            );
        }
        return result;
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

        // Spawn the h1 connection driver and retain its JoinHandle. We must
        // Retain the driver JoinHandle in a guard so we can deterministically
        // abort it if this request is dropped early (e.g. the
        // upstream_request_timeout wrapper in http_proxy.rs drops the
        // forward_request future). On the current hyper version the driver
        // self-terminates when SendRequest is dropped (dispatch channel closes),
        // so a leak is not reproducible today; the explicit abort is
        // defense-in-depth so a future hyper change cannot reintroduce a hung
        // driver holding the socket. The guard is `disarm`ed on the normal
        // completion path so a legitimate response is never interrupted.
        let conn_handle = tokio::spawn(async move {
            let _ = conn.await;
            #[cfg(test)]
            {
                H1_ACTIVE_CONN_DRIVERS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                H1_CONN_DRIVER_NATURAL_COMPLETIONS
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        });
        #[cfg(test)]
        H1_ACTIVE_CONN_DRIVERS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        _conn_driver_guard = ConnDriverAbortOnDrop(Some(conn_handle));

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

    let result = build_upstream_response_from_hyper(response, request, connection_timing, waiting_ms)
        .await;
    // On the normal success path the response body has been fully read; let the
    // conn driver complete naturally (do not abort it). Any error or an early
    // drop of this future (e.g. upstream_request_timeout) skips this line, so
    // the guard fires and aborts the driver, releasing the socket.
    _conn_driver_guard.disarm();
    result
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

    // Surface both the declared and actually-captured body size so that an
    // "empty body" success (e.g. a 200 with zero DATA frames) can be told apart
    // from a capture failure directly from the logs, without inspecting the UI.
    let content_length = response_headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

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
        response_body_size_bytes = response_body_size_bytes,
        content_length = %content_length.map_or_else(|| "n/a".to_string(), |v| v.to_string()),
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
