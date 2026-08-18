use super::*;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

// ---------------------------------------------------------------------------
// CONNECT tunnel handling: blind relay, MITM, HTTPS WebSocket upgrade
// ---------------------------------------------------------------------------

/// Why a client refused the certificate we presented.
///
/// The distinction matters for log severity: one case is a configuration
/// problem the user can fix, the other is a client working exactly as designed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClientHandshakeRejection {
    /// The client could not build a trust chain to our root CA — the
    /// certificate is not installed, or not trusted for TLS on the device.
    /// Actionable, so it stays visible in the log.
    UntrustedRoot,
    /// The client rejected the certificate with a cert-specific alert.
    /// Usually certificate pinning (nothing the user can change will make it
    /// succeed), but be careful: OpenSSL-derived stacks also map some
    /// chain-validation failures (invalid CA, untrusted leaf) to
    /// `bad_certificate`, so this class must not be *reported* as pinning —
    /// only as "certificate rejected". Not worth a warning per connection.
    CertificateRejected,
    /// Anything else: a protocol-level failure, a truncated handshake, I/O.
    Other,
}

/// Classify a failed `TlsAcceptor::accept`.
///
/// The alert code is the useful signal and it is only available on the
/// underlying `rustls::Error`, so downcast rather than matching the formatted
/// string — the `Display` text is not a stable interface.
pub(crate) fn classify_client_handshake_error(error: &std::io::Error) -> ClientHandshakeRejection {
    let Some(rustls_error) = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    else {
        return ClientHandshakeRejection::Other;
    };

    match rustls_error {
        rustls::Error::AlertReceived(alert) => match alert {
            // RFC 8446 §6.2: sent when the chain does not reach a trust anchor.
            rustls::AlertDescription::UnknownCA => ClientHandshakeRejection::UntrustedRoot,
            // "Chain verified, certificate still unacceptable" — the alert a
            // pinning implementation sends. `BadCertificate` and `AccessDenied`
            // show up from stricter stacks for the same reason; OpenSSL-based
            // stacks also use `bad_certificate` for chain failures, hence the
            // deliberately non-committal variant name.
            rustls::AlertDescription::CertificateUnknown
            | rustls::AlertDescription::BadCertificate
            | rustls::AlertDescription::AccessDenied => {
                ClientHandshakeRejection::CertificateRejected
            }
            _ => ClientHandshakeRejection::Other,
        },
        _ => ClientHandshakeRejection::Other,
    }
}

/// Blind TCP relay for CONNECT when SSL interception is disabled.
pub(crate) async fn tunnel_blind_relay<S: AsyncRead + AsyncWrite + Unpin>(
    mut client_stream: S,
    host: &str,
    port: u16,
    dns_manager: &Option<Arc<DnsManager>>,
    workspace_id: &str,
    upstream_proxy: Option<Arc<crate::upstream_proxy::UpstreamProxyConfig>>,
) -> Result<(), String> {
    // Resolve DNS override FIRST (must happen before connecting upstream),
    // then connect the upstream BEFORE telling the client the tunnel is up.
    // If the upstream is unreachable we reply 502 Bad Gateway so the client
    // gets real feedback instead of a fake 200 followed by a dead tunnel (M4).
    //
    // The override is passed to the dialer rather than pre-substituted into the
    // host, so that when an upstream proxy is in play the hostname still
    // reaches it verbatim (its routing rules need the domain, not an IP).
    let dns_override_ip = resolve_dns_override(dns_manager, workspace_id, host);
    if let Some(ip) = &dns_override_ip {
        tracing::info!(
            event = "dns_override_applied",
            host = %host,
            override_ip = %ip,
            "dns_override_applied"
        );
    }
    // Bound the upstream connect so a slow/unreachable target — or a stalled
    // upstream proxy handshake — cannot hold a connection permit indefinitely
    // (H4). On timeout we reply 504 Gateway Timeout, matching the
    // connect-failure path established in M4.
    let connect_result = timeout(
        connect_tunnel_connect_timeout(),
        crate::upstream_proxy::dial_target(upstream_proxy.as_deref(), host, port, dns_override_ip),
    )
    .await;
    let upstream = match connect_result {
        Ok(Ok((stream, route))) => {
            tracing::debug!(
                event = "connect_tunnel_upstream_connected",
                host = %host,
                port = port,
                via_upstream_proxy = matches!(route, crate::upstream_proxy::DialRoute::UpstreamProxy),
                "connect_tunnel_upstream_connected"
            );
            stream
        }
        Ok(Err(e)) => {
            tracing::warn!(
                event = "connect_tunnel_upstream_failed",
                host = %host,
                port = port,
                error = %e,
                "connect_tunnel_upstream_failed"
            );
            let message = format!("failed to connect to upstream {host}:{port}: {e}");
            write_plain_text_response(&mut client_stream, StatusCode::BAD_GATEWAY, &message)
                .await
                .ok();
            return Err(message);
        }
        Err(_elapsed) => {
            tracing::warn!(
                event = "connect_tunnel_upstream_timeout",
                host = %host,
                port = port,
                timeout_secs = connect_tunnel_connect_timeout().as_secs(),
                "connect_tunnel_upstream_timeout"
            );
            let message = format!(
                "timed out connecting to upstream {host}:{port} after {}s",
                connect_tunnel_connect_timeout().as_secs()
            );
            write_plain_text_response(&mut client_stream, StatusCode::GATEWAY_TIMEOUT, &message)
                .await
                .ok();
            return Err(message);
        }
    };

    // Upstream connected — now the tunnel is real. Tell the client.
    client_stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(map_io_error)?;

    // Bidirectional relay with IDLE-RESET timeout, honoring TCP half-close.
    //
    // This is a hand-rolled select loop over `tokio::io::split` reader/writer
    // halves. It replaces an earlier design that wrapped the whole relay in a
    // single overall `timeout(idle, copy_bidirectional(...))` (H4). That overall
    // cap was a product regression for a Charles-like proxy: blind CONNECT
    // tunnels routinely carry LONG-LIVED connections (SSH-over-CONNECT, database
    // tunnels, websocket-over-CONNECT) that are legitimately quiet for >10 min
    // between bursts but must NOT be killed. An overall cap kills active
    // sessions; only an IDLE-RESET (timer reset whenever bytes flow in EITHER
    // direction) correctly distinguishes "hung/half-open" from "legitimately
    // quiet long-lived".
    //
    // Hand-writing the loop (rather than spawning `copy_bidirectional` + a
    // watchdog) is deliberate: it lets us preserve the TCP half-close semantics
    // that a prior audit fix (H6) relied on and that `copy_bidirectional`
    // already implements correctly. The rules:
    //   - On `Ok(0)` (EOF) from one reader: `shutdown` the OTHER side's writer
    //     (half-close) so a server waiting on EOF proceeds and returns its
    //     response, while continuing to flush in-flight data on the surviving
    //     direction. When both directions are done, break.
    //   - On error: break (dropping both streams closes both sides).
    //   - Idle deadline elapsed with NO activity in either direction since the
    //     last reset: break (hung/half-open peer; reclaim the permit).
    //
    // The idle deadline is reset to `now + tunnel_idle_timeout()` whenever ANY
    // non-zero chunk is relayed in EITHER direction. Default 10 min, so a truly
    // silent tunnel ends within that window instead of holding the connection
    // permit forever (max 1024 concurrent) and rejecting all new connections.
    let idle = tunnel_idle_timeout();
    let result = idle_reset_relay(client_stream, upstream, idle).await;

    match result {
        RelayOutcome::IdleTimeout => {
            tracing::warn!(
                event = "tunnel_relay_idle_timeout",
                host = %host,
                idle_timeout_secs = idle.as_secs(),
                "tunnel_relay_idle_timeout"
            );
            // Returning drops both streams (closing both sides) and the permit.
            Ok(())
        }
        RelayOutcome::Error(e) => Err(map_io_error(e)),
        RelayOutcome::Done {
            client_to_upstream_bytes,
            upstream_to_client_bytes,
        } => {
            tracing::debug!(
                event = "tunnel_relay_completed",
                host = %host,
                client_to_upstream_bytes = client_to_upstream_bytes,
                upstream_to_client_bytes = upstream_to_client_bytes,
                "tunnel_relay_completed"
            );
            Ok(())
        }
    }
}

/// Result of the idle-reset bidirectional relay.
enum RelayOutcome {
    /// Both directions reached EOF (or one EOF'd and the other then EOF'd after
    /// its in-flight data was flushed). Counts are bytes relayed per direction.
    Done {
        client_to_upstream_bytes: u64,
        upstream_to_client_bytes: u64,
    },
    /// No activity in either direction for the full idle window.
    IdleTimeout,
    /// An I/O error occurred on either side.
    Error(io::Error),
}

/// Idle-reset bidirectional relay over split halves, preserving TCP half-close.
///
/// See the comment block in `tunnel_blind_relay` for the full design rationale.
async fn idle_reset_relay<S, U>(client_stream: S, upstream: U, idle: Duration) -> RelayOutcome
where
    S: AsyncRead + AsyncWrite + Unpin,
    // Generic over the upstream too: it is a direct TCP stream when dialing the
    // origin, or a proxy-tunneled (possibly TLS-wrapped) stream when an
    // upstream proxy is configured.
    U: AsyncRead + AsyncWrite + Unpin,
{
    let (mut client_read, mut client_write) = tokio::io::split(client_stream);
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);

    let mut client_to_upstream_bytes: u64 = 0;
    let mut upstream_to_client_bytes: u64 = 0;

    // Track whether each direction's writer has been shut down (half-closed).
    // A direction is "done" once its SOURCE reader hits EOF; we then shut down
    // the OTHER side's writer and stop reading that source.
    let mut client_to_upstream_done = false; // client -> upstream direction finished?
    let mut upstream_to_client_done = false; // upstream -> client direction finished?

    let mut buf_client = [0u8; READ_BUFFER_BYTES];
    let mut buf_upstream = [0u8; READ_BUFFER_BYTES];

    let mut idle_deadline = Instant::now() + idle;

    loop {
        // If both directions are finished, the relay is complete.
        if client_to_upstream_done && upstream_to_client_done {
            return RelayOutcome::Done {
                client_to_upstream_bytes,
                upstream_to_client_bytes,
            };
        }

        let now = Instant::now();
        if now >= idle_deadline {
            return RelayOutcome::IdleTimeout;
        }
        let remaining = idle_deadline - now;

        tokio::select! {
            // Idle deadline elapsed with no activity in either direction.
            _ = tokio::time::sleep(remaining) => {
                return RelayOutcome::IdleTimeout;
            }

            // client -> upstream
            read_bytes = async {
                if client_to_upstream_done {
                    // Park forever; this branch must never win when done.
                    std::future::pending::<io::Result<usize>>().await
                } else {
                    client_read.read(&mut buf_client).await
                }
            } => {
                match read_bytes {
                    Ok(0) => {
                        // Client EOF: half-close the upstream writer so a server
                        // waiting on EOF proceeds, and stop reading the client.
                        let _ = upstream_write.shutdown().await;
                        client_to_upstream_done = true;
                    }
                    Ok(n) => {
                        // H4 I1: reset the idle deadline based on when the READ
                        // completed, not when the WRITE finishes. A slow peer
                        // (full TCP receive window / backpressure) must not be
                        // able to consume the idle budget during the write for
                        // data that has already arrived. Capturing this instant
                        // BEFORE write_all keeps slow-write long-lived tunnels
                        // alive — the core H4 guarantee.
                        let read_completed_at = Instant::now();
                        if let Err(e) = upstream_write.write_all(&buf_client[..n]).await {
                            return RelayOutcome::Error(e);
                        }
                        client_to_upstream_bytes += n as u64;
                        idle_deadline = read_completed_at + idle;
                    }
                    Err(e) => return RelayOutcome::Error(e),
                }
            }

            // upstream -> client
            read_bytes = async {
                if upstream_to_client_done {
                    std::future::pending::<io::Result<usize>>().await
                } else {
                    upstream_read.read(&mut buf_upstream).await
                }
            } => {
                match read_bytes {
                    Ok(0) => {
                        // Upstream EOF: half-close the client writer so the
                        // client learns the response is complete, and stop
                        // reading the upstream.
                        let _ = client_write.shutdown().await;
                        upstream_to_client_done = true;
                    }
                    Ok(n) => {
                        // H4 I1: same slow-write protection as the
                        // client->upstream direction — anchor the deadline on
                        // the read-completion instant, not post-write.
                        let read_completed_at = Instant::now();
                        if let Err(e) = client_write.write_all(&buf_upstream[..n]).await {
                            return RelayOutcome::Error(e);
                        }
                        upstream_to_client_bytes += n as u64;
                        idle_deadline = read_completed_at + idle;
                    }
                    Err(e) => return RelayOutcome::Error(e),
                }
            }
        }
    }
}

/// Read a complete HTTP response head (status line + headers) from a stream.
/// Returns the raw head bytes (including the trailing \r\n\r\n) and any body
/// bytes that followed in the same read.
///
/// M4: the head is returned as raw bytes (not a `String`) because HTTP header
/// field values are opaque octets — obs-text / percent-encoded / Latin-1 are
/// legal in the wild (e.g. a `Content-Disposition: filename=` with raw bytes, a
/// Latin-1 status reason, or a non-ASCII `Sec-WebSocket-Protocol` echo). A strict
/// `String::from_utf8` here turned any such byte into a hard error that the WS
/// upgrade path converted into a synthetic 502, even for a perfectly valid 101.
/// Callers that need text (status parsing, logging) should use
/// `String::from_utf8_lossy`; the raw bytes are forwarded to the client verbatim.
pub(crate) async fn read_http_response_head<R: AsyncReadExt + Unpin>(
    reader: &mut R,
) -> Result<(Vec<u8>, Vec<u8>), String> {
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
            return Ok((head, prefix));
        }
    }
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
    // H3: whether new upstream HTTPS/WSS connections verify server certs.
    verify_upstream_tls: bool,
    // H3: per-host allowlist that forces verification even when the global
    // flag is off.
    tls_verify_hosts: Arc<[String]>,
    // Upstream (chained) proxy for outbound connections, or None for direct.
    upstream_proxy: Option<Arc<crate::upstream_proxy::UpstreamProxyConfig>>,
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
            match classify_client_handshake_error(&error) {
                // Most often certificate pinning, in which case nothing the
                // user can change will make it succeed and a warning per
                // connection is pure noise. Not asserted as pinning though:
                // OpenSSL-derived stacks reuse `bad_certificate` for
                // chain-validation failures, which the untrusted-root branch
                // next to this one covers when the client sends `unknown_ca`.
                ClientHandshakeRejection::CertificateRejected => {
                    tracing::debug!(
                        event = "tls_handshake_rejected_by_client",
                        host = %host,
                        port = port,
                        error = %error,
                        "client rejected our certificate (certificate pinning, or strict \
                         validation); exclude this host from SSL proxying to let a pinned \
                         client connect — if captures fail broadly, verify the root CA is \
                         installed"
                    );
                }
                // This one IS fixable: the root CA is missing or not trusted on
                // the device. Keep it prominent.
                ClientHandshakeRejection::UntrustedRoot => {
                    tracing::warn!(
                        event = "tls_handshake_untrusted_root",
                        host = %host,
                        port = port,
                        error = %error,
                        "client does not trust the AIProxy root CA; install it and enable \
                         full trust for it on the device"
                    );
                }
                ClientHandshakeRejection::Other => {
                    tracing::warn!(
                        event = "tls_handshake_failed",
                        host = %host,
                        port = port,
                        error = %error,
                        "tls_handshake_failed"
                    );
                }
            }
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
        verify_upstream_tls,
        tls_verify_hosts,
        upstream_proxy,
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

#[cfg(test)]
mod tests {
    use super::*;

    // M4: `read_http_response_head` must accept a head containing non-UTF-8
    // bytes (legal HTTP obs-text in header values) and return the raw bytes
    // rather than erroring. Previously a strict String::from_utf8 turned any
    // such byte into a hard error that broke valid 101 WS upgrades.
    #[tokio::test]
    async fn read_response_head_accepts_non_utf8_header_bytes() {
        // A 101 with a header value containing a raw 0xE9 byte (Latin-1 'é'),
        // which is invalid UTF-8 on its own.
        let input: &[u8] = b"HTTP/1.1 101 Switching Protocols\r\n\
                             Sec-WebSocket-Protocol: chat-\xE9\r\n\
                             Upgrade: websocket\r\n\
                             \r\n";
        let (head, prefix) = read_http_response_head(&mut &input[..]).await.unwrap();

        // Raw bytes are preserved verbatim.
        assert!(head.starts_with(b"HTTP/1.1 101"));
        assert!(head.contains(&0xE9), "raw non-UTF-8 byte must be preserved");
        assert!(head.ends_with(b"\r\n\r\n"));
        assert!(prefix.is_empty(), "no body bytes in this input");
    }

    #[tokio::test]
    async fn read_response_head_returns_leftover_body_bytes() {
        let input: &[u8] = b"HTTP/1.1 101 Switching Protocols\r\n\r\nextra-body-bytes";
        let (head, prefix) = read_http_response_head(&mut &input[..]).await.unwrap();
        assert!(head.ends_with(b"\r\n\r\n"));
        assert_eq!(prefix, b"extra-body-bytes");
    }
}
