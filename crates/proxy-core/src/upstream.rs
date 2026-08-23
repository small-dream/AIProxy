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

/// Header names that must never be forwarded on an HTTP/2 request.
///
/// `host` is superseded by the `:authority` pseudo-header (RFC 9113 §8.3.1);
/// the rest are connection-specific and explicitly banned (§8.2.2). A strict
/// server answers a stream carrying any of them with PROTOCOL_ERROR rather
/// than ignoring them, so they have to be dropped when a request captured from
/// an h1 client is replayed onto an h2 upstream connection.
pub(crate) fn is_h2_forbidden_request_header(name: &str) -> bool {
    // `te` is conditionally legal (only `te: trailers`), but the captured
    // value is not worth re-validating here — dropping it is always safe.
    const FORBIDDEN: [&str; 7] = [
        "host",
        "connection",
        "keep-alive",
        "proxy-connection",
        "transfer-encoding",
        "upgrade",
        "te",
    ];
    FORBIDDEN
        .iter()
        .any(|forbidden| name.eq_ignore_ascii_case(forbidden))
}

/// Build the absolute-form request URI for the h2 branch.
///
/// `:authority` is derived from this URI, so it must be absolute — but it must
/// also exclude the deprecated userinfo component (`user:pass@`, forbidden in
/// `:authority` by RFC 9113 §8.3.1) and the fragment, both of which
/// `Url::as_str()` would keep. `Url` never serializes a default port, which is
/// semantically equivalent, and `host_str()` keeps IPv6 brackets — valid in an
/// authority.
pub(crate) fn h2_request_uri(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let mut uri = match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    };
    uri.push_str(url.path());
    if let Some(query) = url.query() {
        uri.push('?');
        uri.push_str(query);
    }
    uri
}

// ---------------------------------------------------------------------------
// Upstream request forwarding & response handling
// ---------------------------------------------------------------------------

/// Bound ONE head-phase step (TCP/TLS connect, HTTP handshake, or
/// request-send + response-head wait) by the upstream request timeout
/// (P1-5). Each phase gets its own full budget; only the head phases are
/// capped — the response body is bounded per-chunk by the response-body idle
/// ceiling so large downloads and slow SSE streams are never cut off at an
/// arbitrary total duration.
async fn bound_head_phase<F, T>(fut: F) -> Result<T, ProxyError>
where
    F: std::future::Future<Output = T>,
{
    let deadline = crate::timeout_for(crate::TimeoutKind::UpstreamRequest);
    match tokio::time::timeout(deadline, fut).await {
        Ok(value) => Ok(value),
        Err(_) => {
            let timeout_secs = deadline.as_secs();
            tracing::warn!(
                event = "upstream_head_phase_timed_out",
                timeout_secs,
                "upstream_head_phase_timed_out"
            );
            Err(ProxyError::UpstreamTimeout { timeout_secs })
        }
    }
}

/// Forward a parsed proxy request to the upstream server and return the
/// full response (status, headers, body, timing).
pub(crate) async fn forward_request(
    request: &ParsedProxyRequest,
    dns_manager: &Option<Arc<DnsManager>>,
    workspace_id: &str,
    pool: Option<Arc<crate::upstream_pool::UpstreamConnectionPool>>,
    // H3: verify upstream TLS certs on new connections for this request.
    verify_upstream_tls: bool,
    // H3: per-host allowlist that forces verification even when
    // verify_upstream_tls is false.
    tls_verify_hosts: Arc<[String]>,
    // Upstream (chained) proxy to tunnel this request through, when configured.
    upstream_proxy: Option<Arc<crate::upstream_proxy::UpstreamProxyConfig>>,
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
    // R6-1: treat `wss` like `https` (same TLS transport). The WS upgrade path
    // connects upstream directly and never reaches here, but keep this scheme
    // check aligned so a `wss://` URL could never silently take the plain path.
    let is_https = matches!(request.url.scheme(), "https" | "wss");
    let pool_result = if is_https {
        if let Some(ref p) = pool {
            let key = crate::upstream_pool::UpstreamKey {
                host: request.host.clone(),
                port: request.url.port().unwrap_or(443),
            };
            Some(
                bound_head_phase(p.get_or_connect(
                    &key,
                    dns_override_ip,
                    verify_upstream_tls,
                    Arc::clone(&tls_verify_hosts),
                    upstream_proxy.clone(),
                ))
                .await?
                // get_or_connect reports String errors; the outer ? above only
                // strips bound_head_phase's own ProxyError layer.
                .map_err(ProxyError::from)?,
            )
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

    // Copy request headers as raw `HeaderValue`s so legal non-UTF-8 bytes
    // (obs-text, RFC 9110 §5.5) survive the copy; a `to_str()` round-trip
    // would silently drop such headers entirely.
    for (name, value) in &request.headers {
        if name == http::header::HOST {
            // Re-added explicitly below so it always matches `request.host`.
            // `Builder::header` appends, so copying the captured value here
            // as well would send a duplicate Host header.
            continue;
        }
        http_req_builder = http_req_builder.header(name.clone(), value.clone());
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
            // A reused pooled connection carries no fresh timing, but it was
            // established under the same routing decision this request would
            // make, so report the route rather than defaulting to "direct".
            via_upstream_proxy: upstream_proxy
                .as_ref()
                .is_some_and(|proxy| !proxy.should_bypass(&request.host)),
        });

        // Factory that rebuilds the h2 request from scratch each call, so it can
        // be used for both the initial send and a single retry (M3). The h1
        // branch below still uses the shared `http_req_builder` since it sends
        // exactly once.
        let build_h2_req = || -> Result<http::Request<http_body_util::combinators::BoxBody<bytes::Bytes, String>>, ProxyError> {
            // H2 carries the target in the `:authority` pseudo-header, which
            // hyper derives from the URI — so the URI must be absolute here,
            // unlike the origin-form request-target the h1 branch uses.
            let mut builder = http::Request::builder()
                .method(request.method.clone())
                .uri(h2_request_uri(&request.url));
            for (name, value) in &request.headers {
                // RFC 9113 §8.2.2/§8.3.1: an h2 request must not carry `Host`
                // (it is replaced by `:authority`) nor any connection-specific
                // header. Strict servers reject the whole stream with
                // PROTOCOL_ERROR when they appear — Google's endpoints do,
                // while others silently tolerate them, which is why this only
                // surfaced on some hosts.
                if is_h2_forbidden_request_header(name.as_str()) {
                    continue;
                }
                // Raw values keep legal non-UTF-8 bytes (obs-text) instead of
                // dropping the header.
                builder = builder.header(name.clone(), value.clone());
            }
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
        let response = match bound_head_phase(h2_sender.send_request(build_h2_req()?)).await {
            Ok(Ok(r)) => r,
            Ok(Err(error)) => {
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
                let retry_sender = match pool.as_ref() {
                    Some(p) => {
                        let connect = p.get_or_connect(
                            &pool_key,
                            dns_override_ip,
                            verify_upstream_tls,
                            Arc::clone(&tls_verify_hosts),
                            upstream_proxy.clone(),
                        );
                        // The retry dial is a fresh DNS/TCP/TLS/h2 handshake, so
                        // it must be bounded exactly like the first dial above;
                        // an unbounded await here would hang the request forever
                        // on a stalled reconnect.
                        match bound_head_phase(connect).await {
                            Ok(Ok(sender)) => sender,
                            Ok(Err(error)) => {
                                return Err(ProxyError::UpstreamError(format!(
                                    "failed to reconnect on retry: {error}"
                                )));
                            }
                            Err(timeout @ ProxyError::UpstreamTimeout { .. }) => {
                                return Err(timeout)
                            }
                            Err(other) => return Err(other),
                        }
                    }
                    None => None,
                };
                match retry_sender {
                    Some((mut fresh_sender, _)) => {
                        match bound_head_phase(fresh_sender.send_request(build_h2_req()?)).await {
                            Ok(Ok(r)) => r,
                            Ok(Err(retry_error)) => {
                                if let Some(ref p) = pool {
                                    p.evict_key(&pool_key).await;
                                }
                                return Err(ProxyError::UpstreamError(format!(
                                    "failed to send upstream h2 request after retry: {retry_error}"
                                )));
                            }
                            // P1-5: same eviction discipline as above when
                            // the retried connection also fails to produce a
                            // head in time.
                            Err(error @ ProxyError::UpstreamTimeout { .. }) => {
                                if let Some(ref p) = pool {
                                    p.evict_key(&pool_key).await;
                                }
                                return Err(error);
                            }
                            Err(other) => return Err(other),
                        }
                    }
                    None => {
                        return Err(ProxyError::UpstreamError(format!(
                            "failed to send upstream h2 request: {error}"
                        )));
                    }
                }
            }
            // P1-5: no response head within the deadline — treat like a dead
            // pooled connection (evict so the next request dials fresh) but
            // report the Gateway Timeout cause.
            Err(error @ ProxyError::UpstreamTimeout { .. }) => {
                if let Some(ref p) = pool {
                    p.evict_key(&pool_key).await;
                }
                return Err(error);
            }
            Err(other) => return Err(other),
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
        let mut connector = crate::timing_connector::create_timing_connector(
            dns_override_ip,
            verify_upstream_tls,
            Arc::clone(&tls_verify_hosts),
            upstream_proxy.clone(),
        );
        let uri: http::Uri = request.url.to_string().parse().map_err(|e| {
            ProxyError::UpstreamError(format!(
                "failed to parse upstream URL '{}' as URI: {e}",
                request.url
            ))
        })?;
        // P1-5: each head-phase step gets its own full budget of the upstream
        // request timeout; a stalled dial/handshake no longer relies on an
        // outer total-duration wrapper.
        let (timing_stream, connection_timing) =
            bound_head_phase(tower_service::Service::call(&mut connector, uri))
                .await?
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

        let (sender, conn) = bound_head_phase(hyper::client::conn::http1::handshake(timing_stream))
            .await?
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
        // abort it if this request is dropped early (e.g. a head phase times
        // out and forward_request returns before the body has been read). On
        // the current hyper version the driver
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
    // P1-5: this call resolves when the response HEAD arrives, so it is the
    // last head phase and gets its own full budget of the upstream request
    // timeout. The body read below is NOT covered — it is bounded per-chunk by
    // the response-body idle ceiling instead.
    let response = match bound_head_phase(sender.send_request(http_req)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
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
                "failed to send upstream request: {error}"
            )));
        }
        // Head deadline elapsed. Early-return fires the conn-driver abort
        // guard, releasing the socket.
        Err(error @ ProxyError::UpstreamTimeout { .. }) => return Err(error),
        Err(other) => return Err(other),
    };
    let waiting_ms = waiting_started_at.elapsed().as_millis();

    let result =
        build_upstream_response_from_hyper(response, request, connection_timing, waiting_ms).await;
    // On the normal success path the response body has been fully read; let the
    // conn driver complete naturally (do not abort it). Any error (head-phase
    // timeout, body-idle timeout) or an early drop of this future skips this
    // line, so the guard fires and aborts the driver, releasing the socket.
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
        via_upstream_proxy: Some(connection_timing.via_upstream_proxy),
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
    // P1-4: owns the spool path until the reader completes successfully, so
    // any `?` exit or cancellation deletes the partial file.
    let mut spooled_guard = SpooledResponsePathGuard(None);
    let mut spooled_file: Option<tokio::fs::File> = None;

    if let Some(content_length) = response.content_length() {
        response_body.reserve((content_length as usize).min(MAX_CAPTURED_BODY_BYTES));
    }

    // P1-5: per-chunk idle ceiling instead of a total-duration cap. A body
    // that keeps producing chunks may legitimately take arbitrarily long
    // (large download, slow SSE); a body that goes silent mid-stream is
    // abandoned after the ceiling.
    let idle_ceiling = crate::timeout_for(crate::TimeoutKind::ResponseBodyReadIdle);
    loop {
        // chunk() yields Result<Option<Bytes>>; timeout wraps it with the idle
        // ceiling (P1-5).
        let chunk = match tokio::time::timeout(idle_ceiling, response.chunk()).await {
            Ok(inner) => match inner.map_err(|error| format!("read response chunk: {error}"))? {
                Some(chunk) => chunk,
                None => break,
            },
            Err(_) => {
                return Err(format!(
                    "response body idle timed out after {}s",
                    idle_ceiling.as_secs()
                ));
            }
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
                spooled_guard = SpooledResponsePathGuard(Some(path));
                if !response_body.is_empty() {
                    file.write_all(&response_body)
                        .await
                        .map_err(|error| format!("seed spooled response body: {error}"))?;
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|error| format!("write spooled response chunk: {error}"))?;
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

    // Flush succeeded: hand the spool to the caller. From here on cleanup is
    // UpstreamResponse's responsibility (clear_spooled_response).
    let spooled_response_path = spooled_guard.take();

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
    // P1-4: owns the spool path until the reader completes successfully, so
    // any `?` exit or cancellation deletes the partial file.
    let mut spooled_guard = SpooledResponsePathGuard(None);
    let mut spooled_file: Option<tokio::fs::File> = None;

    let mut body_stream = std::pin::pin!(response.into_body());

    // P1-5: per-chunk idle ceiling instead of a total-duration cap — same
    // contract as the reqwest reader above.
    let idle_ceiling = crate::timeout_for(crate::TimeoutKind::ResponseBodyReadIdle);
    loop {
        let frame = match tokio::time::timeout(idle_ceiling, body_stream.frame()).await {
            Ok(Some(frame_result)) => {
                frame_result.map_err(|error| format!("read hyper response frame: {error}"))?
            }
            Ok(None) => break,
            Err(_) => {
                return Err(format!(
                    "response body idle timed out after {}s",
                    idle_ceiling.as_secs()
                ));
            }
        };

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
                spooled_guard = SpooledResponsePathGuard(Some(path));
                if !response_body.is_empty() {
                    file.write_all(&response_body)
                        .await
                        .map_err(|error| format!("seed spooled response body: {error}"))?;
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|error| format!("write spooled response chunk: {error}"))?;
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

    // Flush succeeded: hand the spool to the caller. From here on cleanup is
    // UpstreamResponse's responsibility (clear_spooled_response).
    let spooled_response_path = spooled_guard.take();

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

/// RAII holder for a spool file path while the body is still being written.
///
/// P1-4: between `create_response_spool_file` and the successful return of a
/// body reader there are several fallible steps (seed write, chunk writes,
/// flush) plus the possibility of the whole future being cancelled. Any of
/// those exits previously leaked the partial spool file into the temp dir.
/// The guard deletes it on drop; the success path calls [`take`](Self::take)
/// to hand ownership to the returned `UpstreamResponse`.
struct SpooledResponsePathGuard(Option<PathBuf>);

impl SpooledResponsePathGuard {
    fn take(&mut self) -> Option<PathBuf> {
        self.0.take()
    }
}

impl Drop for SpooledResponsePathGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            // Same offload rationale as
            // UpstreamResponse::clear_spooled_response (L1): a blocking
            // remove on a Tokio worker stalls it, but during teardown no
            // runtime may exist, in which case remove inline rather than
            // leak the temp file.
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn_blocking(move || {
                    let _ = fs::remove_file(path);
                });
            } else {
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
mod spool_guard_tests {
    use super::*;

    #[tokio::test]
    async fn guard_deletes_the_spool_file_when_dropped_without_take() {
        let request_id = "guard-drop-test";
        let (file, path) = create_response_spool_file(request_id).await.unwrap();
        assert!(path.exists());
        drop(file);

        // Simulate the error/cancellation path: the reader ends without
        // calling take(), so Drop must remove the partial spool.
        {
            let _guard = SpooledResponsePathGuard(Some(path.clone()));
        }
        // Deletion is offloaded to the blocking pool (see Drop); wait briefly
        // for it to land rather than asserting synchronously.
        for _ in 0..100 {
            if !path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !path.exists(),
            "dropped guard must delete the partial spool file"
        );
    }

    #[tokio::test]
    async fn guard_take_hands_ownership_to_the_caller() {
        let request_id = "guard-take-test";
        let (file, path) = create_response_spool_file(request_id).await.unwrap();
        assert!(path.exists());
        drop(file);

        let mut guard = SpooledResponsePathGuard(Some(path.clone()));
        let taken = guard.take().unwrap();
        assert_eq!(taken, path);
        // Success path: dropping the emptied guard must NOT delete the file —
        // cleanup is now UpstreamResponse's responsibility.
        drop(guard);
        assert!(path.exists(), "taken path must survive the guard drop");

        let _ = fs::remove_file(&path);
    }
}
